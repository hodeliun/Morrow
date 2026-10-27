import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { Command } from '../core/commands';
import { planArchiveImport } from '../core/importer';
import { emptyWorkspace } from '../core/model';
import type { DatabaseDef, PageId } from '../core/model';
import { planMarkdownImport } from '../core/portability';
import { databaseFromSubpages, fieldsForMove, releaseRow } from '../core/properties';
import { defaultDatabase, valueOf } from '../core/database';
import { MemoryVault } from './memoryVault';
import { readPageText, readProperty, takeProperties } from '../core/vault/pageFile';
import { WorkspaceSession } from './session';
import { VaultRepository } from './vaultRepository';

let counter = 0;
const newId = () => `id${++counter}`;

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

async function runAll(session: WorkspaceSession, commands: Command[]): Promise<void> {
  const result = session.executeAll(commands);
  if (!result.ok) throw new Error(result.error);
  await session.flush();
}

// what the app's move does: carry the page's values along, then move it
async function move(session: WorkspaceSession, id: PageId, parentId: PageId | null): Promise<void> {
  const state = session.getState();
  const plan = fieldsForMove(state.pages, id, parentId, newId, state);
  await runAll(session, [
    ...(plan?.database
      ? [{ type: 'database.set', id: plan.database.id, database: plan.database.database, now: 5 } as const]
      : []),
    ...(plan
      ? [
          {
            type: 'page.setFields',
            id,
            properties: plan.fields.properties,
            extra: plan.fields.extra,
            now: 5,
          } as const,
        ]
      : []),
    { type: 'page.move', id, parentId },
  ]);
}

const NOTE = '---\ndate: 2024-05-01\nauthor: Ursula\nrating: 4\n---\nA note from obsidian.\n';

describe('frontmatter from other apps', () => {
  it('keeps mixed and oversized relation values intact instead of importing only part of them', async () => {
    const database: DatabaseDef = {
      properties: [{ id: 'links', name: 'Links', type: 'relation', options: [] }],
      views: [],
    };
    const malformed = [{ id: 'valid' }, { unexpected: 'keep' }];
    const extra: Record<string, unknown> = { Links: malformed };
    const properties: Record<string, string | number | boolean | string[] | null> = {};
    takeProperties(database, extra, properties, newId);
    expect(extra.Links).toEqual(malformed);
    expect(properties).toEqual({});

    const oversized = Array.from({ length: 501 }, (_, index) => ({ id: `row-${index}` }));
    expect(readProperty(database.properties[0]!, oversized, newId).value).toBeNull();

    const vault = new MemoryVault({
      'Tasks.md':
        '---\nkind: database\ndatabase:\n  properties:\n    - id: links\n      name: Links\n      type: relation\n  views: []\n---\n',
      'Tasks/Example.md': '---\nLinks:\n  - id: valid\n  - unexpected: keep\n---\nBody\n',
    });
    const session = await open(vault);
    const example = idOf(session, 'Example');
    expect(session.getState().pages[example]!.extra.Links).toEqual(malformed);
    await runAll(session, [{ type: 'page.rename', id: example, title: 'Renamed', now: 3 }]);
    expect(readPageText(vault.text('Tasks/Renamed.md')!).extra.Links).toEqual(malformed);
    await session.close();
  });

  it('roundtrips relation schema and stable row ids through the vault', async () => {
    const authors: DatabaseDef = {
      properties: [
        { id: 'author-name', name: 'Name', type: 'text', options: [] },
        { id: 'books', name: 'Books', type: 'relation', options: [] },
      ],
      views: [],
    };
    const books: DatabaseDef = {
      properties: [
        { id: 'book-name', name: 'Name', type: 'text', options: [] },
        { id: 'author', name: 'Author', type: 'relation', options: [] },
      ],
      views: [],
    };
    const vault = new MemoryVault();
    const session = await open(vault);
    await runAll(session, [
      { type: 'page.create', id: 'authors', parentId: null, title: 'Authors', kind: 'database', now: 1 },
      { type: 'database.set', id: 'authors', database: authors, now: 1 },
      { type: 'page.create', id: 'books', parentId: null, title: 'Books', kind: 'database', now: 1 },
      { type: 'database.set', id: 'books', database: books, now: 1 },
      { type: 'page.create', id: 'author-1', parentId: 'authors', title: 'Asha', now: 1 },
      { type: 'page.create', id: 'book-1', parentId: 'books', title: 'Dune', now: 1 },
      {
        type: 'relation.configure',
        databaseId: 'books',
        propertyId: 'author',
        relation: {
          targetDatabaseId: 'authors',
          multiple: false,
          isInverse: false,
          displayPropertyId: 'author-name',
          inversePropertyId: 'books',
          filters: [],
        },
        now: 2,
      },
      { type: 'page.setProperties', id: 'author-1', values: { 'author-name': 'Asha' }, now: 2 },
      { type: 'page.setProperties', id: 'book-1', values: { 'book-name': 'Dune' }, now: 2 },
      { type: 'relation.set', id: 'book-1', propertyId: 'author', value: 'author-1', now: 3 },
    ]);

    const savedReference = readPageText(vault.text('Books/Dune.md')!).data.Author;
    expect(savedReference).toEqual({ id: 'author-1', title: 'Asha' });
    expect(readPageText(vault.text('Books.md')!).database?.properties[1]?.relation).toMatchObject({
      targetDatabaseId: 'authors',
      displayPropertyId: 'author-name',
      inversePropertyId: 'books',
    });
    await session.close();

    const reopened = await open(vault);
    const state = reopened.getState();
    expect(state.pages['book-1']!.properties.author).toBe('author-1');
    expect(state.pages['author-1']!.properties.books).toBeUndefined();
    expect(valueOf(state.pages['author-1']!, 'books', state.pages.authors!.database!, state)).toEqual([
      'book-1',
    ]);
    await reopened.close();
  });

  it('shows obsidian properties on the page and saves edits to them in place', async () => {
    const vault = new MemoryVault({ 'Note.md': NOTE });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    expect(session.getState().pages[note]!.extra).toEqual({
      date: '2024-05-01',
      author: 'Ursula',
      rating: 4,
    });
    await runAll(session, [
      {
        type: 'page.setFields',
        id: note,
        extra: { date: '2024-05-01', author: 'Ursula K. Le Guin', rating: 4, read: true },
        now: 2,
      },
    ]);
    expect(vault.text('Note.md')).toBe(
      '---\ndate: 2024-05-01\nauthor: Ursula K. Le Guin\nrating: 4\nread: true\n---\nA note from obsidian.\n',
    );
    await session.close();
  });

  it('keeps OKF source objects and concept paths through editing and reopening', async () => {
    const sources = [
      {
        id: 'handbook',
        resource: '/references/handbook.md',
        title: 'Reference handbook',
        signals: { usage_count: 0, human_reviewed: false },
      },
    ];
    const vault = new MemoryVault({
      'Knowledge/index.md': '---\nokf_version: 0.2\n---\n# Knowledge\n',
      'Knowledge/Concept.md':
        '---\ntype: Reference\nsources:\n  - id: handbook\n    resource: /references/handbook.md\n    title: Reference handbook\n    signals:\n      usage_count: 0\n      human_reviewed: false\n---\nSee [the handbook](/references/handbook.md).\n',
      'Knowledge/references/handbook.md': '---\ntype: Reference\n---\nHandbook\n',
      'Loose.md': '---\ntype: Personal note\n---\nUnrelated note\n',
    });
    let session = await open(vault);
    const concept = idOf(session, 'Concept');
    const loose = idOf(session, 'Loose');
    expect(session.getState().pages[concept]!.extra.sources).toEqual(sources);

    await runAll(session, [
      {
        type: 'page.setFields',
        id: concept,
        extra: { ...session.getState().pages[concept]!.extra, description: 'Edited safely' },
        now: 2,
      },
      { type: 'page.rename', id: concept, title: 'A better title', now: 3 },
      { type: 'page.rename', id: loose, title: 'A renamed loose note', now: 4 },
    ]);

    expect(session.pathOf(concept)).toBe('Knowledge/Concept.md');
    expect(session.pathOf(loose)).toBe('A renamed loose note.md');
    expect(vault.text('Knowledge/A better title.md')).toBeUndefined();
    expect(vault.text('Knowledge/Concept.md')).toContain('title: A better title');
    expect(vault.text('Knowledge/Concept.md')).toContain('usage_count: 0');
    expect(vault.text('Knowledge/Concept.md')).toContain('human_reviewed: false');
    expect(vault.text('Knowledge/Concept.md')).toContain('[the handbook](/references/handbook.md)');
    expect(vault.text('A renamed loose note.md')).toContain('type: Personal note');
    await session.close();

    session = await open(vault);
    const reopened = idOf(session, 'A better title');
    expect(session.pathOf(reopened)).toBe('Knowledge/Concept.md');
    expect(session.getState().pages[reopened]!.extra.sources).toEqual(sources);
    expect(session.getState().pages[reopened]!.extra.description).toBe('Edited safely');
    await session.close();
  });

  it('leaves frontmatter beyond safe editing limits untouched and rejects lossy updates', async () => {
    let nested: unknown = 'retained';
    for (let index = 0; index < 66; index++) nested = { child: nested };
    const original = `---\n${stringify({ nested })}---\nOriginal body\n`;
    const vault = new MemoryVault({ 'Deep.md': original });
    const session = await open(vault);
    const deep = idOf(session, 'Deep');

    expect(session.unreadable.has(deep)).toBe(true);
    const update = session.execute({ type: 'page.setFields', id: deep, extra: { nested }, now: 2 });
    expect(update.ok).toBe(false);
    await session.flush();
    expect(vault.text('Deep.md')).toBe(original);
    await session.close();
  });

  it('rewrites only the property that changed, leaving the style and comments of the rest', async () => {
    const text = '---\n# from obsidian\naliases: [Earthsea note]\nauthor: Ursula\nread: true\n---\nBody\n';
    const vault = new MemoryVault({ 'Note.md': text });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    await runAll(session, [
      {
        type: 'page.setFields',
        id: note,
        extra: { aliases: ['Earthsea note'], author: 'Ursula K. Le Guin', rating: 5 },
        now: 2,
      },
    ]);
    expect(vault.text('Note.md')).toBe(
      '---\n# from obsidian\naliases: [Earthsea note]\nauthor: Ursula K. Le Guin\nrating: 5\n---\nBody\n',
    );
    await session.close();
  });

  it('fills a database column whatever the case of the key, and keeps the file spelling', async () => {
    const database = defaultDatabase(newId);
    const vault = new MemoryVault({
      'Reading.md': `---\nkind: database\ndatabase:\n  properties:\n    - id: ${database.properties[1]!.id}\n      name: Date\n      type: date\n  views: []\n---\n`,
      'Reading/Note.md': NOTE,
    });
    const session = await open(vault);
    const note = session.getState().pages[idOf(session, 'Note')]!;
    expect(note.properties[database.properties[1]!.id]).toBe('2024-05-01');
    expect(note.extra).toEqual({ author: 'Ursula', rating: 4 });
    await runAll(session, [{ type: 'page.rename', id: note.id, title: 'Renamed', now: 3 }]);
    // date stays date, no empty Date is added beside it
    expect(vault.text('Reading/Renamed.md')).toBe(
      '---\ndate: 2024-05-01\nauthor: Ursula\nrating: 4\n---\nA note from obsidian.\n',
    );
    await session.close();
  });

  it('keeps a value the column can not hold instead of dropping it', async () => {
    const vault = new MemoryVault({
      'Tasks.md':
        '---\nkind: database\ndatabase:\n  properties:\n    - id: due\n      name: Due\n      type: date\n  views: []\n---\n',
      'Tasks/Call.md': '---\nDue: next tuesday\n---\n',
    });
    const session = await open(vault);
    const call = idOf(session, 'Call');
    expect(session.getState().pages[call]!.extra).toEqual({ Due: 'next tuesday' });
    await runAll(session, [{ type: 'page.rename', id: call, title: 'Call mum', now: 3 }]);
    expect(vault.text('Tasks/Call mum.md')).toBe('---\nDue: next tuesday\n---\n');
    await session.close();
  });

  it('round trips typed formats and applies a default only to rows created after load', async () => {
    const vault = new MemoryVault({
      'Finance.md': `---
kind: database
database:
  properties:
    - id: amount
      name: Amount
      type: currency
      format: { locale: pt-BR, currency: BRL, precision: 2 }
    - id: rate
      name: Rate
      type: percent
      format: { locale: pt-BR, precision: 1 }
    - id: elapsed
      name: Elapsed
      type: duration
      format: { locale: en-US, durationUnit: minutes }
    - id: due
      name: Due
      type: date
    - id: website
      name: Website
      type: url
      format: { linkLabel: Open receipt }
    - id: status
      name: Status
      type: select
      options:
        - { id: backlog, name: Backlog, color: gray }
        - { id: done, name: Done, color: green }
    - id: initial
      name: Initial
      type: number
      fillMode: default
      defaultValue: 0
  views: []
---
`,
      'Finance/Payment.md': `---
Amount: 1234.5
Rate: 0.25
Elapsed: 5400
Due: 2026-01-01
Website: https://example.com/receipt
---
`,
    });
    let session = await open(vault);
    const financeId = idOf(session, 'Finance');
    const paymentId = idOf(session, 'Payment');
    expect(session.getState().pages[paymentId]!.properties).toMatchObject({
      amount: 1234.5,
      rate: 0.25,
      elapsed: 5400,
      due: '2026-01-01',
    });
    expect(session.getState().pages[paymentId]!.properties.initial).toBeUndefined();
    const database = session.getState().pages[financeId]!.database!;
    const elapsed = database.properties.find((property) => property.id === 'elapsed')!;
    const status = database.properties.find((property) => property.id === 'status')!;
    const reversedOptions = [...status.options].reverse();
    await runAll(session, [
      {
        type: 'database.set',
        id: financeId,
        now: 5,
        database: {
          ...database,
          properties: database.properties.map((property) =>
            property.id === elapsed.id
              ? { ...property, format: { ...property.format, durationUnit: 'hours' } }
              : property.id === status.id
                ? { ...property, options: reversedOptions }
                : property,
          ),
        },
      },
      { type: 'page.create', id: 'new-payment', parentId: financeId, now: 6, title: 'New payment' },
      { type: 'page.rename', id: paymentId, title: 'Renamed payment', now: 7 },
    ]);
    expect(session.getState().pages[paymentId]!.properties.elapsed).toBe(5400);
    expect(session.getState().pages['new-payment']!.properties.initial).toBe(0);
    await session.close();

    session = await open(vault);
    const reopened = session.getState().pages[idOf(session, 'Renamed payment')]!;
    const reopenedDb = session.getState().pages[idOf(session, 'Finance')]!.database!;
    expect(reopened.properties).toMatchObject({
      amount: 1234.5,
      rate: 0.25,
      elapsed: 5400,
      due: '2026-01-01',
    });
    expect(reopenedDb.properties.find((property) => property.id === 'elapsed')?.format?.durationUnit).toBe(
      'hours',
    );
    expect(reopenedDb.properties.find((property) => property.id === 'website')?.format?.linkLabel).toBe(
      'Open receipt',
    );
    expect(
      reopenedDb.properties.find((property) => property.id === 'status')?.options.map((option) => option.id),
    ).toEqual(['done', 'backlog']);
    expect(vault.text('Finance/Renamed payment.md')).toContain('Amount: 1234.5');
    expect(vault.text('Finance/Renamed payment.md')).toContain('Elapsed: 5400');
    await session.close();
  });

  it('protects a future column type while allowing a title edit without losing its schema', async () => {
    const vault = new MemoryVault({
      'Projects.md': `---
kind: database
database:
  properties:
    - id: name
      name: Name
      type: text
    - id: future-rating
      name: Rating
      type: futureRating
      precision: 3
  views: []
---
`,
      'Projects/Project.md': '---\nName: Forest\nRating: 4.5\n---\n',
    });
    const session = await open(vault);
    const projectDbId = idOf(session, 'Projects');
    const projectDb = session.getState().pages[projectDbId]!;
    expect(projectDb.database?.unsupportedProperties).toEqual([
      { id: 'future-rating', name: 'Rating', type: 'futureRating', precision: 3 },
    ]);
    await runAll(session, [{ type: 'page.rename', id: projectDbId, title: 'Projects renamed', now: 5 }]);
    expect(vault.text('Projects renamed.md')).toContain('type: futureRating');
    const rowId = idOf(session, 'Project');
    expect(
      session.execute({ type: 'page.setProperties', id: rowId, now: 6, values: { name: 'Changed' } }).ok,
    ).toBe(false);
    await session.close();

    const reopened = await open(vault);
    expect(
      reopened.getState().pages[idOf(reopened, 'Projects renamed')]!.database?.unsupportedProperties,
    ).toEqual([{ id: 'future-rating', name: 'Rating', type: 'futureRating', precision: 3 }]);
    expect(
      readPageText(vault.text('Projects renamed.md')!).database?.properties.map((property) => property.name),
    ).toEqual(['Name']);
    await reopened.close();
  });

  it('turns frontmatter into columns when a page moves into a database, and back when it leaves', async () => {
    const vault = new MemoryVault({ 'Note.md': NOTE });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    await runAll(session, [
      { type: 'page.create', id: 'db', parentId: null, now: 1, title: 'Books', kind: 'database' },
      { type: 'database.set', id: 'db', database: defaultDatabase(newId), now: 1 },
    ]);
    await move(session, note, 'db');
    const db = session.getState().pages.db!.database!;
    expect(db.properties.map((prop) => [prop.name, prop.type])).toEqual([
      ['Status', 'select'],
      ['Date', 'date'],
      ['author', 'text'],
      ['rating', 'number'],
    ]);
    const row = session.getState().pages[note]!;
    expect(row.extra).toEqual({});
    expect(Object.values(row.properties).sort()).toEqual([4, '2024-05-01', 'Ursula'].sort());
    expect(vault.text('Books/Note.md')).toBe(
      '---\ndate: 2024-05-01\nauthor: Ursula\nrating: 4\n---\nA note from obsidian.\n',
    );

    await move(session, note, null);
    expect(session.getState().pages[note]!.properties).toEqual({});
    expect(vault.text('Note.md')).toBe(NOTE);
    await session.close();
  });

  it('keeps the spelling of a key added in morrow when it later fills a column', async () => {
    const vault = new MemoryVault({ 'Note.md': 'Body\n' });
    const session = await open(vault);
    const note = idOf(session, 'Note');
    // added empty first, the way the page header adds one, then filled in
    await runAll(session, [{ type: 'page.setFields', id: note, extra: { status: '' }, now: 2 }]);
    await runAll(session, [{ type: 'page.setFields', id: note, extra: { status: 'Finished' }, now: 2 }]);
    await runAll(session, [
      { type: 'page.create', id: 'db', parentId: null, now: 3, title: 'Books', kind: 'database' },
      { type: 'database.set', id: 'db', database: defaultDatabase(newId), now: 3 },
    ]);
    await move(session, note, 'db');
    expect(vault.text('Books/Note.md')).toBe('---\nstatus: Finished\n---\nBody\n');
    await session.close();
  });

  it('turns a folder of notes into a database with columns from their frontmatter', async () => {
    const vault = new MemoryVault({
      'Books/Dune.md': '---\nstatus: Read\nyear: 1965\ngenre: [sci-fi]\n---\n',
      'Books/Emma.md': '---\nstatus: Reading\nyear: 1815\n---\n',
      'Books/Kindred.md': '---\nstatus: Read\nyear: 1979\nurl: https://example.com\n---\n',
    });
    const session = await open(vault);
    const books = idOf(session, 'Books');
    const adopted = databaseFromSubpages(session.getState().pages, books, newId, () =>
      defaultDatabase(newId),
    );
    expect(adopted.database.properties.map((prop) => [prop.name, prop.type])).toEqual([
      ['status', 'select'],
      ['year', 'number'],
      ['genre', 'multiSelect'],
      ['url', 'url'],
    ]);
    expect(adopted.database.views.map((view) => view.type)).toEqual(['table', 'board']);
    expect(adopted.rows).toHaveLength(3);
    await runAll(session, [
      { type: 'page.setKind', id: books, kind: 'database', now: 2 },
      { type: 'database.set', id: books, database: adopted.database, now: 2 },
      ...adopted.rows.map((row): Command => ({ type: 'page.setFields', ...row, now: 2 })),
    ]);
    // the folder gets a note saying it is a database, the rows' files are unchanged
    expect(vault.text('Books.md')).toContain('kind: database');
    expect(vault.text('Books/Emma.md')).toBe('---\nstatus: Reading\nyear: 1815\n---\n');
    const emma = session.getState().pages[idOf(session, 'Emma')]!;
    expect(releaseRow(emma, session.getState().pages[books]!.database!)).toEqual({
      status: 'Reading',
      year: 1815,
    });
    await session.close();
  });
});

describe('page presentation persistence', () => {
  it('reopens the cover position and note style from managed frontmatter', async () => {
    const vault = new MemoryVault({ 'Character.md': '---\nauthor: Ada\n---\nA portrait note.\n' });
    const session = await open(vault);
    const id = idOf(session, 'Character');
    await runAll(session, [
      { type: 'page.setCover', id, cover: 'Images/portrait.jpg', coverPosition: 68, now: 2 },
      {
        type: 'page.setNoteStyle',
        id,
        style: { font: 'serif', fontSize: 20, lineHeight: 1.8, blockSpacing: 14, width: 'wide' },
        now: 3,
      },
    ]);
    await session.close();

    const saved = vault.text('Character.md');
    expect(saved).toContain('author: Ada');
    expect(saved).toContain('morrowCoverPosition: 68');
    expect(saved).toContain('morrowNoteStyle:');
    const reopened = await open(vault);
    const page = reopened.getState().pages[id]!;
    expect(page.coverPosition).toBe(68);
    expect(page.noteStyle).toEqual({
      font: 'serif',
      fontSize: 20,
      lineHeight: 1.8,
      blockSpacing: 14,
      width: 'wide',
    });
    await reopened.close();
  });
});

describe('importing notes with frontmatter', () => {
  const text =
    '---\ntitle: Real title\nicon: 🌱\ntags: [garden, ideas]\nmood: calm\n---\n# Real title\n\nBody\n';

  it('reads loose files into page fields instead of text', () => {
    const plan = planMarkdownImport(emptyWorkspace(), [{ name: 'note.md', text }], null, newId, 0);
    const page = plan.pages[0]!;
    expect(page).toMatchObject({
      title: 'Real title',
      icon: '🌱',
      tags: ['garden', 'ideas'],
      extra: { mood: 'calm' },
    });
    expect(plan.docs[page.id]).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Body' }] }],
    });
  });

  it('keeps a first heading that differs from the title, and reads archives the same way', () => {
    const data = new TextEncoder().encode('---\ntitle: Short\n---\n# A longer heading\n');
    const plan = planArchiveImport(emptyWorkspace(), [{ path: 'Folder/Short.md', data }], null, newId, 0);
    const page = plan.pages.find((candidate) => candidate.title === 'Short')!;
    expect(plan.docs[page.id]!.content![0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
  });
});
