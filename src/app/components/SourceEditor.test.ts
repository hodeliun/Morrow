import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseDef, DocNode, ViewDef } from '../../core/model';
import { MemoryVault } from '../../storage/memoryVault';
import { WorkspaceSession } from '../../storage/session';
import { VaultRepository } from '../../storage/vaultRepository';
import { markdownToDoc } from '../../core/markdown/parse';
import { sourceMarkdown } from './sourceLinks';
import { saveSourceMarkdown } from './SourceEditor';

let sequence = 0;
const opened: Array<{ session: WorkspaceSession; repository: VaultRepository }> = [];

afterEach(async () => {
  while (opened.length > 0) {
    const { session, repository } = opened.pop()!;
    await session.close();
    repository.close?.();
  }
  vi.restoreAllMocks();
});

function linkedView(id: string, name: string): ViewDef {
  return {
    id,
    name,
    type: 'table',
    filters: [],
    sorts: [],
    groupBy: null,
    dateProp: null,
    hidden: [],
  };
}

async function openLinkedSource(): Promise<{
  session: WorkspaceSession;
  pageId: string;
  doc: DocNode;
  source: string;
}> {
  const repository = new VaultRepository(new MemoryVault({ 'Note.md': 'Original note.\n' }), () => `source-${sequence++}`);
  const result = await WorkspaceSession.open(repository, { delayMs: 60_000 });
  if (!result.ok) throw new Error(result.error);
  const session = result.value;
  opened.push({ session, repository });
  const database: DatabaseDef = { properties: [], views: [linkedView('source-view', 'Source')] };
  const created = session.execute({
    type: 'page.create',
    id: 'source-db',
    parentId: null,
    title: 'Source',
    kind: 'database',
    database,
    now: 1,
  });
  if (!created.ok) throw new Error(created.error);

  const pageId = Object.values(session.getState().pages).find((page) => page.title === 'Note')!.id;
  const initial = session.getState().docs[pageId]!;
  const doc = {
    ...initial,
    content: [
      ...(initial.content ?? []),
      {
        type: 'linkedDatabaseView',
        attrs: {
          hostPageId: pageId,
          sourceDatabaseId: 'source-db',
          blockId: 'linked-block',
          view: linkedView('linked-view', 'Primary'),
          viewRawState: null,
        },
      },
    ],
  } satisfies DocNode;
  const setDoc = session.execute({ type: 'page.setDoc', id: pageId, doc, now: 2 });
  if (!setDoc.ok) throw new Error(setDoc.error);
  const current = session.getState().docs[pageId]!;
  const source = sourceMarkdown(current, session.getState(), pageId, (id) => session.pathOf(id));
  return { session, pageId, doc: current, source };
}

describe('SourceEditor linked-view source writes', () => {
  it('blocks a linked-only source edit when committing another pane changes the source', async () => {
    const { session, pageId, doc, source } = await openLinkedSource();
    const editedSource = source.replace('Primary', 'Renamed');
    expect(editedSource).not.toBe(source);
    const rawParsed = markdownToDoc(editedSource);
    expect(rawParsed.content!.find((node) => node.type === 'linkedDatabaseView')!.attrs?.hostPageId).toBeUndefined();
    const pendingPaneDoc = structuredClone(doc);
    pendingPaneDoc.content![0]!.content![0]!.text = 'Pending text from another pane';
    const write = vi.fn((next: DocNode) =>
      session.execute({ type: 'page.setDoc', id: pageId, doc: next, now: 3 }),
    );

    const saved = saveSourceMarkdown({
      session,
      pageId,
      files: [],
      value: editedSource,
      expectedDoc: doc,
      commitPending: () => {
        const committed = session.execute({ type: 'page.setDoc', id: pageId, doc: pendingPaneDoc, now: 3 });
        if (!committed.ok) throw new Error(committed.error);
      },
      writeDoc: write,
    });

    expect(saved).toEqual({ status: 'conflict' });
    expect(write).not.toHaveBeenCalled();
    expect(session.getState().docs[pageId]!.content![0]!.content![0]!.text).toBe(
      'Pending text from another pane',
    );
    expect((session.getState().docs[pageId]!.content![1]!.attrs!.view as ViewDef).name).toBe('Primary');
    expect(editedSource).toContain('Renamed');
  });

  it('writes an exact linked-only marker edit after reparsing and preserving the host identity', async () => {
    const { session, pageId, doc, source } = await openLinkedSource();
    const editedSource = source.replace('Primary', 'Renamed');
    const write = vi.fn((next: DocNode) =>
      session.execute({ type: 'page.setDoc', id: pageId, doc: next, now: 4 }),
    );

    const saved = saveSourceMarkdown({
      session,
      pageId,
      files: [],
      value: editedSource,
      expectedDoc: doc,
      commitPending: vi.fn(),
      writeDoc: write,
    });

    expect(saved.status).toBe('saved');
    if (saved.status !== 'saved') throw new Error('Expected the source marker update to be saved.');
    expect(saved.writeSucceeded).toBe(true);
    expect(write).toHaveBeenCalledTimes(1);
    const link = session.getState().docs[pageId]!.content![1]!;
    expect(link.attrs?.hostPageId).toBe(pageId);
    expect((link.attrs?.view as ViewDef).name).toBe('Renamed');
  });
});
