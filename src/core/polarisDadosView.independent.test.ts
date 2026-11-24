import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { docToPlainText, findUnknownTypes, validateDoc } from './doc';
import { emptyWorkspace } from './model';
import type { DocNode } from './model';
import { markdownToDoc } from './markdown/parse';
import { docToMarkdown } from './markdown/serialize';
import {
  decodePolarisDadosViewMarker,
  encodePolarisDadosViewMarker,
  isPolarisDadosViewData,
} from './polarisDadosView';
import type { PolarisDadosViewData } from './polarisDadosView';

const MARKER_PREFIX = '<!-- morrow:polaris-dados-view:v1:';
const MARKER_SUFFIX = ' -->';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const sample = (overrides: Partial<PolarisDadosViewData> = {}): PolarisDadosViewData => ({
  version: 1,
  viewId: 'view-one',
  sourceDatabaseId: 'missing-source',
  title: 'Synthetic view',
  columnOrder: ['name', 'quantity'],
  filter: null,
  ...overrides,
});

function markerFromBytes(bytes: Uint8Array): string {
  return MARKER_PREFIX + Buffer.from(bytes).toString('base64url') + MARKER_SUFFIX;
}

function rawMarker(value: unknown): string {
  return markerFromBytes(Buffer.from(JSON.stringify(value), 'utf8'));
}

function markerFromJson(json: string): string {
  return markerFromBytes(Buffer.from(json, 'utf8'));
}

function dataAtPayloadByteSize(size: number): PolarisDadosViewData {
  const columnOrder = Array.from(
    { length: 1000 },
    (_, index) => String(index).padStart(4, '0') + '-' + 'x'.repeat(44),
  );
  const value = sample({ columnOrder });
  let current = Buffer.byteLength(JSON.stringify(value), 'utf8');
  for (let index = 0; index < columnOrder.length && current < size; index++) {
    const room = 128 - columnOrder[index]!.length;
    const added = Math.min(room, size - current);
    if (added <= 0) continue;
    columnOrder[index] += 'x'.repeat(added);
    current += added;
  }
  if (current !== size) throw new Error('Could not make a ' + size + '-byte fixture.');
  return value;
}

const paragraph = (text: string): DocNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

const asDocument = (content: DocNode[]): DocNode => ({ type: 'doc', content });

describe('independent Polaris Dados linked-view codec and document contract', () => {
  it('encodes a stable canonical standalone marker and round-trips adjacent text and special titles', () => {
    const value = sample({
      title: 'Título ✨\nsegunda linha --> preservada',
      sourceDatabaseId: 'source/that-is-not-in-this-vault',
      filter: { propertyId: 'quantity', op: 'gte', value: 0 },
    });
    expect(isPolarisDadosViewData(value)).toBe(true);

    const marker = encodePolarisDadosViewMarker(value);
    expect(marker).toMatch(/^<!-- morrow:polaris-dados-view:v1:[A-Za-z0-9_-]+ -->$/);
    expect(marker).not.toContain('=');
    expect(encodePolarisDadosViewMarker(value)).toBe(marker);
    expect(decodePolarisDadosViewMarker(marker)).toEqual(value);

    const source = 'Text before the view.\n\n' + marker + '\n\nText after the view.\n';
    const parsed = markdownToDoc(source);
    expect(parsed.content?.map((node) => node.type)).toEqual([
      'paragraph',
      'polarisDadosView',
      'paragraph',
    ]);
    expect(parsed.content?.[0]).toEqual(paragraph('Text before the view.'));
    expect(parsed.content?.[1]).toEqual({ type: 'polarisDadosView', attrs: value });
    expect(parsed.content?.[2]).toEqual(paragraph('Text after the view.'));

    const serialized = docToMarkdown(parsed);
    expect(serialized).toContain(marker);
    expect(markdownToDoc(serialized)).toEqual(parsed);
  });

  it('accepts stated field limits and a payload exactly 64 KiB, then rejects overflow', () => {
    const atFieldLimits = sample({
      viewId: 'v'.repeat(128),
      sourceDatabaseId: 's'.repeat(128),
      title: 't'.repeat(300),
      columnOrder: [
        'c'.repeat(128),
        ...Array.from({ length: 999 }, (_, index) => 'column-' + index),
      ],
    });
    expect(isPolarisDadosViewData(atFieldLimits)).toBe(true);
    expect(() => encodePolarisDadosViewMarker(atFieldLimits)).not.toThrow();
    expect(isPolarisDadosViewData(sample({ viewId: '   ' }))).toBe(false);
    expect(isPolarisDadosViewData(sample({ sourceDatabaseId: '   ' }))).toBe(false);
    const paddedIds = sample({
      viewId: ' view-one ',
      sourceDatabaseId: ' missing-source ',
      columnOrder: [' name '],
      filter: { propertyId: ' quantity ', op: 'gte', value: 0 },
    });
    expect(isPolarisDadosViewData(paddedIds)).toBe(true);
    expect(decodePolarisDadosViewMarker(encodePolarisDadosViewMarker(paddedIds))).toEqual(paddedIds);
    expect(
      isPolarisDadosViewData(
        sample({ columnOrder: ['c'.repeat(129)] }),
      ),
    ).toBe(false);

    const exactly64KiB = dataAtPayloadByteSize(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(exactly64KiB), 'utf8')).toBe(64 * 1024);
    expect(isPolarisDadosViewData(exactly64KiB)).toBe(true);
    expect(() => encodePolarisDadosViewMarker(exactly64KiB)).not.toThrow();

    const over64KiB = structuredClone(exactly64KiB);
    const writableId = over64KiB.columnOrder.findIndex((id) => id.length < 128);
    expect(writableId).toBeGreaterThanOrEqual(0);
    over64KiB.columnOrder[writableId] += 'x';
    expect(Buffer.byteLength(JSON.stringify(over64KiB), 'utf8')).toBe(64 * 1024 + 1);
    expect(isPolarisDadosViewData(over64KiB)).toBe(false);
    expect(() => encodePolarisDadosViewMarker(over64KiB)).toThrow(TypeError);
  });

  it('rejects malformed, non-canonical, unknown-version, extra-field, and invalid-UTF-8 markers', () => {
    const validMarker = encodePolarisDadosViewMarker(sample());
    const encoded = validMarker.slice(MARKER_PREFIX.length, -MARKER_SUFFIX.length);
    const rawBytes = Buffer.from(encoded, 'base64url');
    const remainder = rawBytes.length % 3;
    expect(remainder).not.toBe(0);
    const padMask = remainder === 1 ? 0b1111 : 0b0011;
    const lastIndex = BASE64URL.indexOf(encoded.at(-1)!);
    const nonCanonicalLast = (lastIndex & ~padMask) | 1;
    const nonCanonical = encoded.slice(0, -1) + BASE64URL[nonCanonicalLast];

    const invalidUtf8 = markerFromBytes(
      new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    );
    const missingFilter: Record<string, unknown> = { ...sample() };
    delete missingFilter.filter;
    const cases = [
      'not a marker',
      validMarker + ' trailing text',
      MARKER_PREFIX + encoded + '= -->',
      MARKER_PREFIX + encoded.replace(/[A-Za-z0-9_-]/, '/') + MARKER_SUFFIX,
      MARKER_PREFIX + nonCanonical + MARKER_SUFFIX,
      '<!-- morrow:polaris-dados-view:v2:' + encoded + MARKER_SUFFIX,
      rawMarker({ ...sample(), version: 2 }),
      rawMarker({ ...sample(), futureOption: { opaque: true } }),
      markerFromJson('{"version":1,}'),
      markerFromJson(
        '{"sourceDatabaseId":"missing-source","viewId":"view-one","version":1,"title":"Synthetic view","columnOrder":["name","quantity"],"filter":null}',
      ),
      markerFromJson(
        '{"version":1, "viewId":"view-one","sourceDatabaseId":"missing-source","title":"Synthetic view","columnOrder":["name","quantity"],"filter":null}',
      ),
      markerFromJson(
        '{"version":1,"version":1,"viewId":"view-one","sourceDatabaseId":"missing-source","title":"Synthetic view","columnOrder":["name","quantity"],"filter":null}',
      ),
      markerFromJson(
        '\uFEFF{"version":1,"viewId":"view-one","sourceDatabaseId":"missing-source","title":"Synthetic view","columnOrder":["name","quantity"],"filter":null}',
      ),
      markerFromJson(
        '{"version":1,"viewId":"view-one","sourceDatabaseId":"missing-source","title":"Synthetic view","columnOrder":["name","quantity"],"filter":{"propertyId":"quantity","op":"gte","value":1.0}}',
      ),
      markerFromJson(
        '{"version":1,"viewId":"view-one","sourceDatabaseId":"missing-source","title":"Synthetic view","columnOrder":["name","quantity"],"filter":{"op":"gte","propertyId":"quantity","value":1}}',
      ),
      rawMarker({ ...sample(), viewId: '' }),
      rawMarker({ ...sample(), viewId: '   ' }),
      rawMarker({ ...sample(), sourceDatabaseId: '' }),
      rawMarker({ ...sample(), sourceDatabaseId: '   ' }),
      rawMarker(missingFilter),
      rawMarker({ ...sample(), viewId: 'v'.repeat(129) }),
      rawMarker({ ...sample(), sourceDatabaseId: 's'.repeat(129) }),
      rawMarker({ ...sample(), title: 't'.repeat(301) }),
      rawMarker({ ...sample(), columnOrder: ['same', 'same'] }),
      rawMarker({ ...sample(), columnOrder: ['   '] }),
      rawMarker({ ...sample(), columnOrder: ['name', 1] }),
      rawMarker({ ...sample(), columnOrder: Array.from({ length: 1001 }, (_, index) => 'id-' + index) }),
      rawMarker({
        ...sample(),
        filter: { propertyId: 'p'.repeat(129), op: 'gte', value: 2 },
      }),
      rawMarker({
        ...sample(),
        filter: { propertyId: '   ', op: 'gte', value: 2 },
      }),
      rawMarker({ ...sample(), filter: { propertyId: 'quantity', op: 'gt', value: 2 } }),
      rawMarker({
        ...sample(),
        filter: { propertyId: 'quantity', op: 'gte', value: 2, futureOption: true },
      }),
      invalidUtf8,
    ];

    for (const marker of cases) {
      expect(decodePolarisDadosViewMarker(marker)).toBeNull();
      expect(isPolarisDadosViewData({ marker })).toBe(false);
    }
  });

  it('validates direct DocNode input semantically and refuses duplicate view IDs before page.setDoc', () => {
    const value = sample();
    const validNode: DocNode = { type: 'polarisDadosView', attrs: value };
    const validDoc = asDocument([paragraph('before'), validNode, paragraph('after')]);
    const validated = validateDoc(validDoc);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(findUnknownTypes(validated.value)).toEqual([]);

    const invalidNodes: DocNode[] = [
      { type: 'polarisDadosView', attrs: { ...value, futureOption: true } },
      {
        type: 'polarisDadosView',
        attrs: {
          version: value.version,
          viewId: value.viewId,
          sourceDatabaseId: value.sourceDatabaseId,
          title: value.title,
          columnOrder: value.columnOrder,
        },
      },
      { type: 'polarisDadosView', attrs: { ...value, version: 2 } },
      { type: 'polarisDadosView' },
      { type: 'polarisDadosView', attrs: value, content: [] },
      { type: 'polarisDadosView', attrs: value, content: [paragraph('nested')] },
      { type: 'polarisDadosView', attrs: value, text: 'unexpected text' },
      { type: 'polarisDadosView', attrs: value, marks: [] },
      { ...({ type: 'polarisDadosView', attrs: value, id: 'extra-node-field' } as unknown as DocNode) },
      {
        type: 'polarisDadosView',
        attrs: { ...value, filter: { propertyId: 'quantity', op: 'gte', value: Infinity } },
      },
    ];
    for (const node of invalidNodes) {
      expect(validateDoc(asDocument([paragraph('adjacent'), node])).ok).toBe(false);
    }
    const inlinePlacement = asDocument([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'before' }, validNode, { type: 'text', text: 'after' }],
      },
    ]);
    const tableCellPlacement = asDocument([
      {
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              {
                type: 'tableCell',
                content: [paragraph('before'), validNode],
              },
            ],
          },
        ],
      },
    ]);
    expect(validateDoc(inlinePlacement).ok).toBe(false);
    expect(validateDoc(tableCellPlacement).ok).toBe(false);
    expect(() => docToMarkdown(inlinePlacement)).toThrow();

    const firstListAtom = asDocument([
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [validNode] }],
      },
    ]);
    const firstTaskAtom = asDocument([
      {
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: false }, content: [validNode] }],
      },
    ]);
    const listHeadingBeforeAtom = asDocument([
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Heading' }] },
              validNode,
            ],
          },
        ],
      },
    ]);
    const listBlockquoteBeforeAtom = asDocument([
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'blockquote', content: [validNode] }],
          },
        ],
      },
    ]);
    expect(validateDoc(firstListAtom).ok).toBe(false);
    expect(validateDoc(firstTaskAtom).ok).toBe(false);
    expect(validateDoc(listHeadingBeforeAtom).ok).toBe(false);
    expect(validateDoc(listBlockquoteBeforeAtom).ok).toBe(false);
    expect(() => docToMarkdown(firstListAtom)).toThrow();
    expect(() => docToMarkdown(firstTaskAtom)).toThrow();
    expect(() => docToMarkdown(listHeadingBeforeAtom)).toThrow();
    expect(() => docToMarkdown(listBlockquoteBeforeAtom)).toThrow();

    const supportedNested = asDocument([
      {
        type: 'blockquote',
        content: [validNode],
      },
    ]);
    expect(validateDoc(supportedNested).ok).toBe(true);
    expect(markdownToDoc(docToMarkdown(supportedNested))).toEqual(supportedNested);

    const duplicateDoc = asDocument([
      paragraph('before'),
      { type: 'polarisDadosView', attrs: value },
      { type: 'polarisDadosView', attrs: { ...value, title: 'second occurrence' } },
      paragraph('after'),
    ]);
    expect(validateDoc(duplicateDoc).ok).toBe(false);

    const created = applyCommand(emptyWorkspace(), {
      type: 'page.create',
      id: 'note-1',
      parentId: null,
      title: 'Synthetic note',
      now: 1,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const initialDoc = created.value.state.docs['note-1'];
    const result = applyCommand(created.value.state, {
      type: 'page.setDoc',
      id: 'note-1',
      doc: duplicateDoc,
      now: 2,
    });
    expect(result.ok).toBe(false);
    expect(created.value.state.docs['note-1']).toBe(initialDoc);
  });

  it('provides a readable inert plain-text fallback without a provider', () => {
    const value = sample({ title: 'Useful title', sourceDatabaseId: 'missing-source' });
    const doc = asDocument([
      paragraph('text before'),
      { type: 'polarisDadosView', attrs: value },
      paragraph('text after'),
    ]);
    expect(docToPlainText(doc)).toContain(value.title);
    expect(docToPlainText(doc)).toContain('Linked view unavailable');
    expect(docToPlainText(doc)).toContain(value.sourceDatabaseId);
    expect(docToPlainText(doc)).not.toContain('quantity');
  });
});
