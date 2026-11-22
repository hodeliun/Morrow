import { describe, expect, it } from 'vitest';
import type { DocNode, PageId } from '../core/model';
import { walk } from '../core/doc';
import type { Command } from '../core/commands';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let generatedId = 0;
const newId = () => `retarget-recovery-${++generatedId}`;

function registryFor(paths: string[]): string {
  return JSON.stringify({
    version: 1,
    pages: Object.fromEntries(
      paths.map((path, index) => [path, { id: `retarget-recovery-page-${index + 1}` }]),
    ),
  });
}

function makeFiles(files: Record<string, string>): Record<string, string> {
  return {
    ...files,
    '.morrow/workspace.json': registryFor(Object.keys(files)),
    '.morrow/recent.json': JSON.stringify({ version: 1, opened: {}, activity: {} }),
  };
}

class PartialFailureVault extends MemoryVault {
  readonly attempts: VaultOp[][] = [];
  failBefore: ((op: VaultOp) => boolean) | null = null;

  override async apply(operations: VaultOp[]): Promise<VaultOpResult[]> {
    const attempted: VaultOp[] = [];
    this.attempts.push(attempted);
    const results: VaultOpResult[] = [];
    for (const op of operations) {
      attempted.push(op);
      if (this.failBefore?.(op)) {
        this.failBefore = null;
        results.push({ ok: false, code: 'error', message: 'injected failure before operation' });
        break;
      }
      const [result] = await super.apply([op]);
      results.push(result!);
      if (!result!.ok) break;
    }
    return results;
  }
}

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const opened = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 60_000 });
  if (!opened.ok) throw new Error(opened.error);
  const saved = await opened.value.flush();
  if (!saved) throw new Error('The synthetic vault did not finish its initial save.');
  return opened.value;
}

function pageIdAt(session: WorkspaceSession, path: string): PageId {
  const id = Object.keys(session.getState().pages).find((candidate) => session.pathOf(candidate) === path);
  if (!id) throw new Error(`No page at ${path}`);
  return id;
}

function markdownPageLinks(doc: DocNode): DocNode[] {
  const links: DocNode[] = [];
  walk(doc, (node) => {
    if (node.type === 'pageLink' && typeof node.attrs?.markdownHref === 'string') links.push(node);
    return true;
  });
  return links;
}

function pageLinks(doc: DocNode): DocNode[] {
  const links: DocNode[] = [];
  walk(doc, (node) => {
    if (node.type === 'pageLink') links.push(node);
    return true;
  });
  return links;
}

function execute(session: WorkspaceSession, commands: Command[]): void {
  const result = session.executeAll(commands);
  if (!result.ok) throw new Error(result.error);
}

function lastAttempt(vault: PartialFailureVault): VaultOp[] {
  return vault.attempts[vault.attempts.length - 1] ?? [];
}

describe('partial page-link retarget recovery through VaultRepository', () => {
  it('retries a confirmed target move after repeated referrer write failures without repeating the rename', async () => {
    const suffix = '?view=raw%2f#Section%2F';
    const sourceText = `[Target](./Target.md${suffix})\n`;
    const vault = new PartialFailureVault(
      makeFiles({
        'Notes/Source.md': sourceText,
        'Notes/Target.md': '# Target\n',
        'Archive/Keep.md': '# Keep folder\n',
        'Unrelated.md': 'Keep exact bytes.\n',
      }),
    );
    const unrelatedMtime = vault.modifiedTime('Unrelated.md');
    const session = await open(vault);
    const sourceId = pageIdAt(session, 'Notes/Source.md');
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const archiveId = pageIdAt(session, 'Archive');
    const referrer = 'Notes/Source.md';

    try {
      vault.attempts.length = 0;
      vault.failBefore = (op) => op.op === 'write' && op.path === referrer;
      execute(session, [
        { type: 'page.move', id: targetId, parentId: archiveId },
        { type: 'page.rename', id: targetId, title: 'Target moved', now: 4 },
      ]);

      expect(await session.flush()).toBe(false);
      expect(vault.attempts[0]?.some((op) => op.op === 'rename')).toBe(true);
      expect(vault.text(referrer)).toBe(sourceText);
      expect(session.pathOf(targetId)).toBe('Archive/Target moved.md');

      vault.failBefore = (op) => op.op === 'write' && op.path === referrer;
      const firstRetry = vault.attempts.length;
      expect(await session.flush()).toBe(false);
      expect(lastAttempt(vault).some((op) => op.op === 'rename')).toBe(false);
      expect(vault.text(referrer)).toBe(sourceText);

      const secondRetry = vault.attempts.length;
      expect(await session.flush()).toBe(true);
      expect(vault.attempts.length).toBeGreaterThan(secondRetry);
      expect(
        vault.attempts.slice(firstRetry).every((attempt) => !attempt.some((op) => op.op === 'rename')),
      ).toBe(true);
      expect(vault.text(referrer)).toBe(`[Target](../Archive/Target%20moved.md${suffix})\n`);
      expect(vault.modifiedTime('Unrelated.md')).toBe(unrelatedMtime);

      await session.close();
      const reopened = await open(vault);
      try {
        const reopenedSourceId = pageIdAt(reopened, referrer);
        const reopenedTargetId = pageIdAt(reopened, 'Archive/Target moved.md');
        expect(reopenedTargetId).toBe(targetId);
        expect(markdownPageLinks(reopened.getState().docs[reopenedSourceId]!)).toContainEqual(
          expect.objectContaining({
            type: 'pageLink',
            attrs: expect.objectContaining({
              id: targetId,
              markdownHref: `../Archive/Target%20moved.md${suffix}`,
            }),
          }),
        );
        expect(reopenedSourceId).toBe(sourceId);
      } finally {
        await reopened.close();
      }
    } finally {
      if (!session.isClosed) await session.close();
    }
  });

  it('replays current raw Markdown and Wiki destinations after a second confirmed target move', async () => {
    const suffix = '?view=raw%2f#Section%2F';
    const sourceText = `[[Target|Friendly]]\n[Target](./Target.md${suffix})\n`;
    const vault = new PartialFailureVault(
      makeFiles({
        'Notes/Source.md': sourceText,
        'Notes/Target.md': '# Target\n',
        'Archive/Keep.md': '# Keep folder\n',
        'Else/Keep.md': '# Another folder\n',
      }),
    );
    const session = await open(vault);
    const sourceId = pageIdAt(session, 'Notes/Source.md');
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const archiveId = pageIdAt(session, 'Archive');
    const elseId = pageIdAt(session, 'Else');

    try {
      execute(session, [
        { type: 'page.move', id: targetId, parentId: archiveId },
        { type: 'page.rename', id: targetId, title: 'First', now: 4 },
      ]);
      expect(await session.flush()).toBe(true);
      const firstRetarget = `[[First|Friendly]]\n[Target](../Archive/First.md${suffix})\n`;
      expect(vault.text('Notes/Source.md')).toBe(firstRetarget);

      vault.attempts.length = 0;
      vault.failBefore = (op) => op.op === 'write' && op.path === 'Notes/Source.md';
      execute(session, [
        { type: 'page.move', id: targetId, parentId: elseId },
        { type: 'page.rename', id: targetId, title: 'Second', now: 5 },
      ]);

      expect(await session.flush()).toBe(false);
      expect(vault.text('Notes/Source.md')).toBe(firstRetarget);
      const retryStart = vault.attempts.length;
      expect(await session.flush()).toBe(true);
      expect(vault.attempts.slice(retryStart).flat().some((op) => op.op === 'rename')).toBe(false);
      expect(vault.text('Notes/Source.md')).toBe(
        `[[Second|Friendly]]\n[Target](../Else/Second.md${suffix})\n`,
      );

      await session.close();
      const reopened = await open(vault);
      try {
        const reopenedSourceId = pageIdAt(reopened, 'Notes/Source.md');
        const reopenedTargetId = pageIdAt(reopened, 'Else/Second.md');
        expect(reopenedSourceId).toBe(sourceId);
        expect(reopenedTargetId).toBe(targetId);
        const links = markdownPageLinks(reopened.getState().docs[reopenedSourceId]!);
        expect(links).toHaveLength(1);
        expect(links[0]!.attrs).toMatchObject({
          id: targetId,
          markdownHref: `../Else/Second.md${suffix}`,
        });
      } finally {
        await reopened.close();
      }
    } finally {
      if (!session.isClosed) await session.close();
    }
  });

  it('replays a Wiki-only referrer after a confirmed target rename', async () => {
    const sourceText = '[[Target|Friendly]]\n';
    const vault = new PartialFailureVault(
      makeFiles({
        'Notes/Source.md': sourceText,
        'Notes/Target.md': '# Target\n',
        'Archive/Keep.md': '# Keep folder\n',
      }),
    );
    const session = await open(vault);
    const sourceId = pageIdAt(session, 'Notes/Source.md');
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const archiveId = pageIdAt(session, 'Archive');

    try {
      vault.attempts.length = 0;
      vault.failBefore = (op) => op.op === 'write' && op.path === 'Notes/Source.md';
      execute(session, [
        { type: 'page.move', id: targetId, parentId: archiveId },
        { type: 'page.rename', id: targetId, title: 'Moved', now: 4 },
      ]);

      expect(await session.flush()).toBe(false);
      expect(vault.text('Notes/Source.md')).toBe(sourceText);
      const retryStart = vault.attempts.length;
      expect(await session.flush()).toBe(true);
      expect(vault.attempts.slice(retryStart).flat().some((op) => op.op === 'rename')).toBe(false);
      expect(vault.text('Notes/Source.md')).toBe('[[Moved|Friendly]]\n');

      await session.close();
      const reopened = await open(vault);
      try {
        expect(pageIdAt(reopened, 'Notes/Source.md')).toBe(sourceId);
        expect(pageIdAt(reopened, 'Archive/Moved.md')).toBe(targetId);
      } finally {
        await reopened.close();
      }
    } finally {
      if (!session.isClosed) await session.close();
    }
  });

  it('preserves the same Wiki target when another folder gains its basename, with and without retry', async () => {
    for (const failReferrerWrite of [false, true]) {
      const vault = new PartialFailureVault(
        makeFiles({
          'Notes/Source.md': '[[Target]]\n',
          'Notes/Target.md': '# Intended target\n',
          'Else/Existing.md': '# Competing page\n',
        }),
      );
      const session = await open(vault);
      const sourceId = pageIdAt(session, 'Notes/Source.md');
      const intendedTargetId = pageIdAt(session, 'Notes/Target.md');
      const competingId = pageIdAt(session, 'Else/Existing.md');
      const initialLink = pageLinks(session.getState().docs[sourceId]!)[0];
      expect(initialLink?.attrs).toMatchObject({ id: intendedTargetId });

      try {
        vault.attempts.length = 0;
        if (failReferrerWrite) {
          vault.failBefore = (op) => op.op === 'write' && op.path === 'Notes/Source.md';
        }
        execute(session, [{ type: 'page.rename', id: competingId, title: 'Target', now: 4 }]);

        if (failReferrerWrite) {
          expect(await session.flush()).toBe(false);
          expect(vault.text('Notes/Source.md')).toBe('[[Target]]\n');
          expect(vault.text('Else/Target.md')).toBeDefined();
          const competingMtime = vault.modifiedTime('Else/Target.md');
          const retryStart = vault.attempts.length;

          expect(await session.flush()).toBe(true);
          const retryOps = vault.attempts.slice(retryStart).flat();
          expect(retryOps.some((op) => op.op === 'rename')).toBe(false);
          expect(retryOps.some((op) => op.op === 'write' && op.path === 'Notes/Source.md')).toBe(true);
          expect(retryOps.some((op) => op.op === 'write' && op.path === 'Else/Target.md')).toBe(false);
          expect(vault.modifiedTime('Else/Target.md')).toBe(competingMtime);
        } else {
          expect(await session.flush()).toBe(true);
        }

        expect(vault.text('Notes/Source.md')).toBe('[[Notes/Target]]\n');
        await session.close();
        const reopened = await open(vault);
        try {
          const reopenedSourceId = pageIdAt(reopened, 'Notes/Source.md');
          const reopenedTargetId = pageIdAt(reopened, 'Notes/Target.md');
          expect(reopenedTargetId).toBe(intendedTargetId);
          expect(pageIdAt(reopened, 'Else/Target.md')).toBe(competingId);
          expect(pageLinks(reopened.getState().docs[reopenedSourceId]!)[0]!.attrs).toMatchObject({
            id: intendedTargetId,
          });
        } finally {
          await reopened.close();
        }
      } finally {
        if (!session.isClosed) await session.close();
      }
    }
  });

  it('replays a source-only move using its current directory and the stable target id', async () => {
    const suffix = '?mode=raw%2f#Anchor%2F';
    const sourceText = `[Target](./Target.md${suffix})\n`;
    const vault = new PartialFailureVault(
      makeFiles({
        'Notes/Source.md': sourceText,
        'Notes/Target.md': '# Target\n',
        'Archive/Keep.md': '# Keep folder\n',
      }),
    );
    const session = await open(vault);
    const sourceId = pageIdAt(session, 'Notes/Source.md');
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const archiveId = pageIdAt(session, 'Archive');
    const movedSource = 'Archive/Source.md';

    try {
      vault.attempts.length = 0;
      vault.failBefore = (op) => op.op === 'write' && op.path === movedSource;
      execute(session, [{ type: 'page.move', id: sourceId, parentId: archiveId }]);

      expect(await session.flush()).toBe(false);
      expect(vault.attempts[0]?.some((op) => op.op === 'rename')).toBe(true);
      expect(vault.text(movedSource)).toBe(sourceText);
      expect(session.pathOf(sourceId)).toBe(movedSource);

      const attemptCount = vault.attempts.length;
      expect(await session.flush()).toBe(true);
      expect(vault.attempts.length).toBeGreaterThan(attemptCount);
      expect(
        vault.attempts.slice(attemptCount).every((attempt) => !attempt.some((op) => op.op === 'rename')),
      ).toBe(true);
      const updated = `[Target](../Notes/Target.md${suffix})\n`;
      expect(vault.text(movedSource)).toBe(updated);

      await session.close();
      const reopened = await open(vault);
      try {
        const reopenedSourceId = pageIdAt(reopened, movedSource);
        expect(reopened.getState().docs[reopenedSourceId]).toBeDefined();
        expect(markdownPageLinks(reopened.getState().docs[reopenedSourceId]!)[0]!.attrs).toMatchObject({
          id: targetId,
          markdownHref: `../Notes/Target.md${suffix}`,
        });
      } finally {
        await reopened.close();
      }
    } finally {
      if (!session.isClosed) await session.close();
    }
  });

  it('keeps confirmed workspace metadata writes as the retry compare baseline', async () => {
    const suffix = '?mode=raw%2f#Anchor%2F';
    const sourceText = '[Target](./Target.md' + suffix + ')\n';
    const vault = new PartialFailureVault(
      makeFiles({
        'Notes/Source.md': sourceText,
        'Notes/Target.md': '# Target\n',
        'Archive/Keep.md': '# Keep folder\n',
      }),
    );
    const session = await open(vault);
    const sourceId = pageIdAt(session, 'Notes/Source.md');
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const archiveId = pageIdAt(session, 'Archive');
    const initialWorkspace = vault.text('.morrow/workspace.json');
    const initialRecent = vault.text('.morrow/recent.json');

    try {
      const edited = structuredClone(session.getState().docs[sourceId]!);
      let changedLink = false;
      walk(edited, (node) => {
        if (node.type !== 'pageLink' || changedLink) return true;
        node.attrs = { ...node.attrs, alias: 'Edited target' };
        changedLink = true;
        return true;
      });
      expect(changedLink).toBe(true);

      vault.attempts.length = 0;
      vault.failBefore = (op) => op.op === 'write' && op.path === '.morrow/recent.json';
      execute(session, [
        { type: 'page.move', id: targetId, parentId: archiveId },
        { type: 'page.rename', id: targetId, title: 'First', now: 4 },
        { type: 'page.setDoc', id: sourceId, doc: edited, now: 5 },
      ]);

      expect(await session.flush()).toBe(false);
      const firstWrites = lastAttempt(vault);
      const sourceWriteAt = firstWrites.findIndex((op) => op.op === 'write' && op.path === 'Notes/Source.md');
      const workspaceWriteAt = firstWrites.findIndex(
        (op) => op.op === 'write' && op.path === '.morrow/workspace.json',
      );
      const recentWriteAt = firstWrites.findIndex(
        (op) => op.op === 'write' && op.path === '.morrow/recent.json',
      );
      expect(sourceWriteAt).toBeGreaterThanOrEqual(0);
      expect(workspaceWriteAt).toBeGreaterThan(sourceWriteAt);
      expect(recentWriteAt).toBeGreaterThan(workspaceWriteAt);
      expect(vault.text('.morrow/workspace.json')).not.toBe(initialWorkspace);
      expect(vault.text('.morrow/recent.json')).toBe(initialRecent);
      const confirmedWorkspace = vault.text('.morrow/workspace.json');
      const retryStart = vault.attempts.length;

      expect(await session.flush()).toBe(true);
      expect(session.queue.status.errorCode).toBeNull();
      const retryOps = vault.attempts.slice(retryStart).flat();
      expect(
        retryOps.find((op) => op.op === 'check' && op.path === '.morrow/workspace.json'),
      ).toMatchObject({ expect: confirmedWorkspace });
      expect(vault.text('Notes/Source.md')).toBe(`[Edited target](../Archive/First.md${suffix})\n`);
    } finally {
      await session.close();
    }
  });

  it('recomputes a retained link when the source move lands before the target move', async () => {
    const suffix = '?view=raw%2f#Section%2F';
    const sourceText = '[Target](./Target.md' + suffix + ')\n';
    const vault = new PartialFailureVault(
      makeFiles({
        'Source.md': sourceText,
        'Target.md': '# Target\n',
        'Archive/Keep.md': '# Keep folder\n',
        'Unrelated.md': 'Keep exact bytes.\n',
      }),
    );
    const unrelatedMtime = vault.modifiedTime('Unrelated.md');
    const session = await open(vault);
    const sourceId = pageIdAt(session, 'Source.md');
    const targetId = pageIdAt(session, 'Target.md');
    const archiveId = pageIdAt(session, 'Archive');

    try {
      vault.attempts.length = 0;
      vault.failBefore = (op) => op.op === 'rename' && op.from === 'Target';
      execute(session, [
        { type: 'page.move', id: sourceId, parentId: archiveId },
        { type: 'page.move', id: targetId, parentId: archiveId },
        { type: 'page.rename', id: targetId, title: 'Moved', now: 4 },
      ]);

      expect(await session.flush()).toBe(false);
      expect(lastAttempt(vault).filter((op) => op.op === 'rename').map((op) => op.from)).toContain(
        'Source',
      );
      expect(lastAttempt(vault).filter((op) => op.op === 'rename').map((op) => op.from)).toContain(
        'Target',
      );
      expect(vault.text('Archive/Source.md')).toBe(sourceText);
      expect(vault.text('Target.md')).toBe('# Target\n');

      const retryStart = vault.attempts.length;
      expect(await session.flush()).toBe(true);
      const retried = vault.attempts.slice(retryStart).flat();
      expect(retried.some((op) => op.op === 'rename' && op.from === 'Source')).toBe(false);
      expect(vault.text('Archive/Source.md')).toBe(`[Target](./Moved.md${suffix})\n`);
      expect(vault.modifiedTime('Unrelated.md')).toBe(unrelatedMtime);

      await session.close();
      const reopened = await open(vault);
      try {
        const reopenedSourceId = pageIdAt(reopened, 'Archive/Source.md');
        const reopenedTargetId = pageIdAt(reopened, 'Archive/Moved.md');
        expect(reopenedSourceId).toBe(sourceId);
        expect(reopenedTargetId).toBe(targetId);
        expect(markdownPageLinks(reopened.getState().docs[reopenedSourceId]!)[0]!.attrs).toMatchObject({
          id: targetId,
          markdownHref: `./Moved.md${suffix}`,
        });
      } finally {
        await reopened.close();
      }
    } finally {
      if (!session.isClosed) await session.close();
    }
  });

  it('keeps a completed referrer out of retry when another referrer write fails', async () => {
    const suffix = '?q=1#A';
    const sourceText = `[Target](./Target.md${suffix})\n`;
    const vault = new PartialFailureVault(
      makeFiles({
        'Notes/SourceA.md': sourceText,
        'Notes/SourceB.md': sourceText,
        'Notes/Target.md': '# Target\n',
        'Archive/Keep.md': '# Keep folder\n',
        'Unrelated.md': 'No write.\n',
      }),
    );
    const unrelatedMtime = vault.modifiedTime('Unrelated.md');
    const session = await open(vault);
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const archiveId = pageIdAt(session, 'Archive');
    const sourcePaths = new Set(['Notes/SourceA.md', 'Notes/SourceB.md']);

    try {
      vault.attempts.length = 0;
      let matchingWrites = 0;
      vault.failBefore = (op) => {
        if (op.op !== 'write' || !sourcePaths.has(op.path)) return false;
        matchingWrites++;
        return matchingWrites === 2;
      };
      execute(session, [
        { type: 'page.move', id: targetId, parentId: archiveId },
        { type: 'page.rename', id: targetId, title: 'Moved', now: 4 },
      ]);

      expect(await session.flush()).toBe(false);
      const changed = [...sourcePaths].filter((path) => vault.text(path) !== sourceText);
      expect(changed).toHaveLength(1);
      const completed = changed[0]!;
      const pending = [...sourcePaths].find((path) => path !== completed)!;
      expect(vault.text(pending)).toBe(sourceText);

      const attemptOffset = vault.attempts.length;
      expect(await session.flush()).toBe(true);
      const retried = vault.attempts.slice(attemptOffset).flat();
      expect(retried.some((op) => op.op === 'rename')).toBe(false);
      expect(retried.some((op) => op.op === 'write' && op.path === completed)).toBe(false);
      expect(retried.some((op) => op.op === 'write' && op.path === pending)).toBe(true);
      expect(vault.text(completed)).toBe(vault.text(pending));
      expect(vault.text(completed)).toContain(`../Archive/Moved.md${suffix}`);
      expect(vault.modifiedTime('Unrelated.md')).toBe(unrelatedMtime);
    } finally {
      await session.close();
    }
  });

  it('uses the latest document target id instead of a stale pending raw href', async () => {
    const suffix = '?q=raw%2f#Fragment%2F';
    const sourceText = `[Target](./Target.md${suffix})\n`;
    const vault = new PartialFailureVault(
      makeFiles({
        'Notes/Source.md': sourceText,
        'Notes/Target.md': '# Target\n',
        'Notes/Other.md': '# Other\n',
        'Archive/Keep.md': '# Keep folder\n',
      }),
    );
    const session = await open(vault);
    const sourceId = pageIdAt(session, 'Notes/Source.md');
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const otherId = pageIdAt(session, 'Notes/Other.md');
    const archiveId = pageIdAt(session, 'Archive');

    try {
      vault.attempts.length = 0;
      vault.failBefore = (op) => op.op === 'write' && op.path === 'Notes/Source.md';
      execute(session, [
        { type: 'page.move', id: targetId, parentId: archiveId },
        { type: 'page.rename', id: targetId, title: 'Moved', now: 4 },
      ]);
      expect(await session.flush()).toBe(false);

      const edited = structuredClone(session.getState().docs[sourceId]!);
      let changedLink = false;
      walk(edited, (node) => {
        if (node.type !== 'pageLink' || changedLink) return true;
        node.attrs = { ...node.attrs, id: otherId, alias: 'Other now' };
        changedLink = true;
        return true;
      });
      expect(changedLink).toBe(true);
      execute(session, [{ type: 'page.setDoc', id: sourceId, doc: edited, now: 5 }]);

      expect(await session.flush()).toBe(true);
      expect(vault.text('Notes/Source.md')).toBe(`[Other now](./Other.md${suffix})\n`);
      expect(vault.text('Notes/Source.md')).not.toContain('../Archive/Moved.md');

      await session.close();
      const reopened = await open(vault);
      try {
        const reopenedSourceId = pageIdAt(reopened, 'Notes/Source.md');
        expect(markdownPageLinks(reopened.getState().docs[reopenedSourceId]!)[0]!.attrs).toMatchObject({
          id: otherId,
          markdownHref: `./Other.md${suffix}`,
        });
      } finally {
        await reopened.close();
      }
    } finally {
      if (!session.isClosed) await session.close();
    }
  });

  it('preserves an external referrer change and reports a retry conflict after a partial move', async () => {
    const sourceText = '[Target](./Target.md?q=raw#Fragment)\n';
    const externalText = '[External edit](./External.md?x=1#Keep)\n';
    const vault = new PartialFailureVault(
      makeFiles({
        'Notes/Source.md': sourceText,
        'Notes/Target.md': '# Target\n',
        'Archive/Keep.md': '# Keep folder\n',
      }),
    );
    const session = await open(vault);
    const targetId = pageIdAt(session, 'Notes/Target.md');
    const archiveId = pageIdAt(session, 'Archive');

    try {
      vault.attempts.length = 0;
      vault.failBefore = (op) => op.op === 'write' && op.path === 'Notes/Source.md';
      execute(session, [
        { type: 'page.move', id: targetId, parentId: archiveId },
        { type: 'page.rename', id: targetId, title: 'Moved', now: 4 },
      ]);
      expect(await session.flush()).toBe(false);
      expect(session.queue.status.errorCode).not.toBe('save-conflict');

      vault.external({ 'Notes/Source.md': externalText });
      expect(vault.text('Notes/Source.md')).toBe(externalText);

      expect(await session.flush()).toBe(false);
      expect(session.queue.status.errorCode).toBe('save-conflict');
      expect(session.queue.status.error).toContain('page-link referrer');
      expect(vault.text('Notes/Source.md')).toBe(externalText);
      expect(
        lastAttempt(vault).some(
          (op) => op.op === 'rename' || (op.op === 'write' && op.path === 'Notes/Source.md'),
        ),
      ).toBe(false);
      expect(session.pathOf(targetId)).toBe('Archive/Moved.md');
    } finally {
      session.queue.dispose();
      await session.close();
    }
  });
});
