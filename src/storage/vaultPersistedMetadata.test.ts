import { describe, expect, it } from 'vitest';
import { encryptPage, newPageKey } from '../core/crypto';
import type { DocNode, PageId } from '../core/model';
import { MemoryVault } from './memoryVault';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let counter = 0;
const newId = () => `encrypted-metadata-${++counter}`;

const doc = (...texts: string[]): DocNode => ({
  type: 'doc',
  content: texts.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] })),
});

async function open(vault: MemoryVault): Promise<WorkspaceSession> {
  const session = await WorkspaceSession.open(new VaultRepository(vault, newId), { delayMs: 0 });
  if (!session.ok) throw new Error(session.error);
  return session.value;
}

function idOf(session: WorkspaceSession, title: string): PageId {
  const page = Object.values(session.getState().pages).find((candidate) => candidate.title === title);
  if (!page) throw new Error(`no page ${title}`);
  return page.id;
}

async function run(session: WorkspaceSession, command: Parameters<WorkspaceSession['execute']>[0]): Promise<void> {
  const result = session.execute(command);
  if (!result.ok) throw new Error(result.error);
  await session.flush();
}

const NONCANONICAL_DATABASE = [
  '---',
  'title: Diary',
  'kind: database',
  'database:',
  '  properties:',
  '    - id: safe-field',
  '      name: Safe field',
  '      type: text',
  '      options: []',
  '  views:',
  '    - id: table',
  '      name: Table',
  '      type: table',
  '      filters: []',
  '      sorts: []',
  '      groupBy: null',
  '      dateProp: null',
  '      hidden: []',
  '---',
  '# Diary',
  '',
].join('\n');

describe('confirmed metadata after encrypted-page unlock', () => {
  it('keeps noncanonical ciphertext on open-only activity and still persists a real edit', async () => {
    const password = 'synthetic encrypted metadata password';
    const encrypted = await encryptPage(NONCANONICAL_DATABASE, await newPageKey(password));
    const vault = new MemoryVault({ 'Diary.md': encrypted });
    const session = await open(vault);
    const diary = idOf(session, 'Diary');

    expect((await session.unlockPage(diary, 'wrong password')).ok).toBe(false);
    expect(vault.text('Diary.md')).toBe(encrypted);
    expect((await session.unlockPage(diary, password)).ok).toBe(true);
    await run(session, { type: 'page.markOpened', id: diary, now: 30 });
    expect(vault.text('Diary.md')).toBe(encrypted);
    await session.close();

    const reopened = await open(vault);
    expect((await reopened.unlockPage(diary, password)).ok).toBe(true);
    await run(reopened, { type: 'page.setDoc', id: diary, doc: doc('Edited secret.'), now: 31 });
    const editedCiphertext = vault.text('Diary.md');
    expect(editedCiphertext).toBeDefined();
    expect(editedCiphertext).not.toBe(encrypted);
    expect(editedCiphertext).not.toContain('Edited secret.');
    await reopened.close();

    const editedReopen = await open(vault);
    expect((await editedReopen.unlockPage(diary, password)).ok).toBe(true);
    expect(editedReopen.getState().docs[diary]).toEqual(doc('Edited secret.'));
    await editedReopen.close();
  });
});
