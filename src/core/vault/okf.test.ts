import { describe, expect, it } from 'vitest';
import { newPageMeta } from '../model';
import type { PageId, PageMeta, WorkspaceState } from '../model';
import { diagnoseOkfPage, isOkfPath, okfBundleRootForPath } from './okf';

describe('OKF bundle scope and diagnostics', () => {
  const page = (id: string, title: string, parentId: string | null, extra: Record<string, unknown> = {}) =>
    newPageMeta({ id, title, parentId, extra });

  it('uses the nearest marked index and leaves typed notes outside bundles alone', () => {
    const pages: Record<PageId, PageMeta> = {
      knowledge: page('knowledge', 'Knowledge', null),
      index: page('index', 'index', 'knowledge', { okf_version: 0.2 }),
      concept: page('concept', 'Concept', 'knowledge', { type: 'Reference' }),
      research: page('research', 'Research', 'knowledge'),
      nestedIndex: page('nestedIndex', 'index', 'research', { okf_version: '0.2' }),
      nestedConcept: page('nestedConcept', 'Nested concept', 'research', { type: 'Reference' }),
      target: page('target', 'Valid target', 'research'),
      loose: page('loose', 'Loose note', null, { type: 'Personal note' }),
    };
    const paths = new Map<PageId, string>([
      ['knowledge', 'Knowledge'],
      ['index', 'Knowledge/index.md'],
      ['concept', 'Knowledge/Concept.md'],
      ['research', 'Knowledge/Research'],
      ['nestedIndex', 'Knowledge/Research/index.md'],
      ['nestedConcept', 'Knowledge/Research/Nested.md'],
      ['target', 'Knowledge/Research/references/valid.md'],
      ['loose', 'Loose.md'],
    ]);
    const pathOf = (id: PageId) => paths.get(id) ?? null;
    const state: WorkspaceState = { pages, docs: {} };

    expect(okfBundleRootForPath(state, 'Knowledge/Concept.md', pathOf)).toBe('Knowledge');
    expect(okfBundleRootForPath(state, 'Knowledge', pathOf)).toBe('Knowledge');
    expect(okfBundleRootForPath(state, 'Knowledge/Research/Nested.md', pathOf)).toBe('Knowledge/Research');
    expect(isOkfPath(state, 'Loose.md', pathOf)).toBe(false);
    expect(diagnoseOkfPage(pages.loose!, 'Loose.md', state, undefined, pathOf)).toEqual([]);
  });

  it('validates type, source objects and local links without requiring provenance', () => {
    const concept = page('concept', 'Concept', null, {
      type: 'Reference',
      sources: [{ id: 'bad-source' }],
    });
    const index = page('index', 'index', null, { okf_version: 0.2 });
    const target = page('target', 'Target', null);
    const pages: Record<PageId, PageMeta> = { index, concept, target };
    const paths = new Map<PageId, string>([
      ['index', 'Knowledge/index.md'],
      ['concept', 'Knowledge/Concept.md'],
      ['target', 'Knowledge/references/valid.md'],
    ]);
    const pathOf = (id: PageId) => paths.get(id) ?? null;
    const state: WorkspaceState = { pages, docs: {} };
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'valid',
              marks: [{ type: 'link', attrs: { href: '/references/valid.md' } }],
            },
            {
              type: 'text',
              text: 'missing',
              marks: [{ type: 'link', attrs: { href: '/references/missing.md' } }],
            },
            { type: 'text', text: 'outside', marks: [{ type: 'link', attrs: { href: '../Loose.md' } }] },
          ],
        },
      ],
    };

    expect(diagnoseOkfPage(concept, 'Knowledge/Concept.md', state, doc, pathOf)).toEqual([
      { code: 'invalid-source-resource' },
      { code: 'missing-link-target', href: '/references/missing.md' },
      { code: 'invalid-link-path', href: '../Loose.md' },
    ]);
  });

  it('accepts absent optional provenance and diagnoses a missing concept type', () => {
    const index = page('index', 'index', null, { okf_version: '0.2' });
    const concept = page('concept', 'Concept', null);
    const pages: Record<PageId, PageMeta> = { index, concept };
    const paths = new Map<PageId, string>([
      ['index', 'Bundle/index.md'],
      ['concept', 'Bundle/Concept.md'],
    ]);
    const pathOf = (id: PageId) => paths.get(id) ?? null;

    expect(diagnoseOkfPage(concept, 'Bundle/Concept.md', { pages, docs: {} }, undefined, pathOf)).toEqual([
      { code: 'missing-type' },
    ]);
  });

  it('warns when a reserved index or log file is marked as a concept', () => {
    const index = page('index', 'index', null, { okf_version: 0.2 });
    const log = page('log', 'log', null, { type: 'History' });
    const pages: Record<PageId, PageMeta> = { index, log };
    const paths = new Map<PageId, string>([
      ['index', 'Bundle/index.md'],
      ['log', 'Bundle/log.md'],
    ]);
    const pathOf = (id: PageId) => paths.get(id) ?? null;

    expect(diagnoseOkfPage(log, 'Bundle/log.md', { pages, docs: {} }, undefined, pathOf)).toEqual([
      { code: 'reserved-filename' },
    ]);
  });
});
