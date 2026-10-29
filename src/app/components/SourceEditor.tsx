import { useEffect, useMemo, useRef, useState } from 'react';
import { validateDoc } from '../../core/doc';
import { markdownToDoc } from '../../core/markdown/parse';
import type { DocNode, FileMeta, PageId } from '../../core/model';
import { dirname } from '../../core/vault/paths';
import { getSession, run } from '../workspace';
import { t } from '../i18n';
import { sourceFileResolver, sourceMarkdown, sourceMarkdownParseOptions } from './sourceLinks';

const SAVE_DELAY_MS = 500;

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
    const state = session.getState();
    const sourcePath = session.pathOf(pageId);
    const parsed = markdownToDoc(value, {
      ...sourceMarkdownParseOptions(
        state,
        pageId,
        (id) => session.pathOf(id),
        sourceFileResolver(files, sourcePath ? dirname(sourcePath) : null),
      ),
    });
    const valid = validateDoc(parsed);
    if (!valid.ok) {
      setError(t('dialogs.markdownUnreadable'));
      return;
    }
    setError(null);
    run({ type: 'page.setDoc', id: pageId, doc: valid.value, now: Date.now() });
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
