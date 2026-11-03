import { useEffect, useMemo, useRef, useState } from 'react';
import { validateDoc } from '../../core/doc';
import { markdownToDoc } from '../../core/markdown/parse';
import type { DocNode, FileMeta, PageId } from '../../core/model';
import { dirname } from '../../core/vault/paths';
import { getSession, run } from '../workspace';
import { t } from '../i18n';
import { sourceFileResolver, sourceMarkdown, sourceMarkdownParseOptions } from './sourceLinks';
import { commitEditors } from '../editor/commits';
import { runLinkedViewConfigWrite } from '../editor/linkedViewConfigSync';

const SAVE_DELAY_MS = 500;

export type SourceMarkdownSaveResult =
  | { status: 'conflict' }
  | { status: 'invalid' }
  | { status: 'saved'; doc: DocNode; writeSucceeded: boolean };

export function saveSourceMarkdown(options: {
  session: ReturnType<typeof getSession>;
  pageId: PageId;
  files: FileMeta[];
  value: string;
  expectedDoc: DocNode;
  commitPending?: () => void;
  writeDoc?: (doc: DocNode) => ReturnType<typeof run>;
}): SourceMarkdownSaveResult {
  const { session, pageId, files, value, expectedDoc } = options;
  const state = session.getState();
  const parse = (parseState: typeof state) => {
    const sourcePath = session.pathOf(pageId);
    return markdownToDoc(value, {
      ...sourceMarkdownParseOptions(
        parseState,
        pageId,
        (id) => session.pathOf(id),
        sourceFileResolver(files, sourcePath ? dirname(sourcePath) : null),
      ),
    });
  };
  const parsed = validateDoc(parse(state));
  if (!parsed.ok) return { status: 'invalid' };

  const writeDoc = options.writeDoc ?? ((doc: DocNode) => run({ type: 'page.setDoc', id: pageId, doc, now: Date.now() }));
  const guarded = runLinkedViewConfigWrite({
    hostPageId: pageId,
    expectedDoc,
    proposedDoc: parsed.value,
    commitPending: options.commitPending ?? commitEditors,
    currentDoc: () => session.getState().docs[pageId],
    reparse: (currentDoc) => {
      const currentState = session.getState();
      if (currentState.docs[pageId] !== currentDoc) return null;
      const reparsed = validateDoc(parse(currentState));
      return reparsed.ok ? reparsed.value : null;
    },
    write: writeDoc,
  });
  if (guarded.status === 'conflict') return { status: 'conflict' };
  if (guarded.status === 'invalid') return { status: 'invalid' };
  const nextDoc = guarded.status === 'written' ? guarded.doc : parsed.value;
  const result = guarded.status === 'written' ? guarded.result : writeDoc(nextDoc);
  return { status: 'saved', doc: nextDoc, writeSucceeded: result.ok };
}

// the page as the markdown in its file, edited directly and read back as you type
export function SourceEditor({ pageId, doc, editable }: { pageId: PageId; doc: DocNode; editable: boolean }) {
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const initial = useMemo(
    () => {
      const session = getSession();
      return sourceMarkdown(doc, session.getState(), pageId, (id) => session.pathOf(id));
    },
    // the text is only produced when the source opens, later changes come from typing here
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageId],
  );
  const [text, setText] = useState(initial);
  const sourceDoc = useRef(doc);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    void getSession()
      .listFiles()
      .then((list) => live && setFiles(list))
      .catch(() => live && setFiles([]));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const element = area.current;
    if (!element) return;
    element.style.height = '0px';
    element.style.height = `${Math.max(320, element.scrollHeight)}px`;
  }, [text]);

  const save = (value: string) => {
    if (!files) return;
    const session = getSession();
    const result = saveSourceMarkdown({ session, pageId, files, value, expectedDoc: sourceDoc.current });
    if (result.status === 'conflict') {
      setError(t('database.linkedViewUpdateConflict'));
      return;
    }
    if (result.status === 'invalid') {
      setError(t('dialogs.markdownUnreadable'));
      return;
    }
    setError(null);
    if (result.writeSucceeded) sourceDoc.current = result.doc;
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <div className="source-editor">
      <textarea
        ref={area}
        className="source-text"
        value={text}
        readOnly={!editable}
        spellCheck={false}
        aria-label={t('dialogs.markdownSource')}
        onChange={(event) => {
          const value = event.target.value;
          setText(value);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => save(value), SAVE_DELAY_MS);
        }}
        onBlur={() => {
          if (!timer.current) return;
          clearTimeout(timer.current);
          timer.current = null;
          save(text);
        }}
      />
      {error && (
        <p className="source-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
