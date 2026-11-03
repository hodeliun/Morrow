import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { newPageMeta } from '../model';
import { loadVault } from './load';
import { composeFrontmatter, managedFrontmatter, readPageText } from './pageFile';

function frontmatter(values: Record<string, unknown>): string {
  const yaml = stringify(values);
  return `---\n${yaml}${yaml.endsWith('\n') ? '' : '\n'}---\nSynthetic body.\n`;
}

describe('calculated result background frontmatter', () => {
  it('round trips explicit choices and retains unrelated metadata', () => {
    for (const enabled of [true, false]) {
      const sourceText = frontmatter({ futurePreference: { keep: ['unknown', 3] } });
      const sourceRead = readPageText(sourceText);
      const source = sourceRead.source;
      const page = {
        ...newPageMeta({ id: `note-${enabled}`, parentId: null, title: 'Synthetic' }),
        calculatedResultBackground: enabled,
      };
      const composed = composeFrontmatter(
        managedFrontmatter(page, 'Synthetic', null),
        sourceRead.extra,
        source,
      );
      const reread = readPageText(frontmatter(composed));

      expect(reread.error).toBeNull();
      expect(reread.calculatedResultBackground).toBe(enabled);
      expect(reread.data.futurePreference).toEqual({ keep: ['unknown', 3] });
    }
  });

  it('leaves the legacy field absent and rejects malformed known values without normalizing them', () => {
    const legacyText = frontmatter({ futurePreference: 'keep' });
    const legacy = readPageText(legacyText);
    expect(legacy.error).toBeNull();
    expect(legacy.calculatedResultBackground).toBeNull();
    expect(managedFrontmatter(
      newPageMeta({ id: 'legacy-note', parentId: null, title: 'Legacy' }),
      'Legacy',
      null,
    ).has('morrowCalculatedResultBackground')).toBe(false);

    const malformedText = frontmatter({ morrowCalculatedResultBackground: 'off' });
    const malformed = readPageText(malformedText);
    expect(malformed.error).toMatch(/calculated result background/i);
    expect(malformed.source.rawData?.morrowCalculatedResultBackground).toBe('off');

    const loaded = loadVault({
      files: [{ path: 'Malformed.md', text: malformedText, mtime: 1, birthtime: 1 }],
      folders: [],
      others: [],
      registry: null,
      recent: null,
    }, () => 'unused-id');
    expect(loaded.unreadable).toHaveLength(1);
    expect(loaded.problems.join('\n')).toMatch(/calculated result background/i);
    expect(loaded.sources.has('unused-id')).toBe(false);
    expect(malformedText).toContain('morrowCalculatedResultBackground: off');
  });
});
