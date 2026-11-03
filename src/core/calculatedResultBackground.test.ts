import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { emptyDoc, emptyWorkspace, newPageMeta } from './model';
import { normalizePage } from './migrations';
import { createBackup, parseBackup } from './portability';

describe('calculated result background metadata', () => {
  it('keeps legacy pages distinguishable from explicit page choices', () => {
    expect(newPageMeta({ id: 'legacy-note', parentId: null }).calculatedResultBackground).toBeNull();
    const oldSnapshot = normalizePage({ id: 'old-snapshot', parentId: null });
    expect(oldSnapshot).not.toBeNull();
    expect(oldSnapshot?.calculatedResultBackground).toBeNull();
    expect(normalizePage({
      id: 'legacy-null', parentId: null, calculatedResultBackground: null,
    })?.calculatedResultBackground).toBeNull();
    const enabled = normalizePage({
      id: 'enabled-snapshot', parentId: null, calculatedResultBackground: true,
    });
    expect(enabled).not.toBeNull();
    expect(enabled?.calculatedResultBackground).toBe(true);
    const disabled = normalizePage({
      id: 'disabled-snapshot', parentId: null, calculatedResultBackground: false,
    });
    expect(disabled).not.toBeNull();
    expect(disabled?.calculatedResultBackground).toBe(false);
    expect(normalizePage({
      id: 'malformed-snapshot', parentId: null, calculatedResultBackground: 'off',
    })).toBeNull();
  });

  it('creates notes with the captured choice and updates only the selected note', () => {
    const created = applyCommand(emptyWorkspace(), {
      type: 'page.create',
      id: 'new-note',
      parentId: null,
      now: 1,
      title: 'New note',
      calculatedResultBackground: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.state.pages['new-note']?.calculatedResultBackground).toBe(false);

    const updated = applyCommand(created.value.state, {
      type: 'page.setCalculatedResultBackground',
      id: 'new-note',
      enabled: true,
      now: 2,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.value.state.pages['new-note']?.calculatedResultBackground).toBe(true);
    expect(updated.value.state.pages['new-note']?.updatedAt).toBe(2);
    expect(created.value.state.pages['new-note']?.calculatedResultBackground).toBe(false);
  });

  it('preserves a page choice when the page is duplicated', () => {
    const created = applyCommand(emptyWorkspace(), {
      type: 'page.create', id: 'source-note', parentId: null, now: 1,
      calculatedResultBackground: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const duplicated = applyCommand(created.value.state, {
      type: 'page.duplicate', id: 'source-note', newId: 'copied-note', now: 2,
    });
    expect(duplicated.ok).toBe(true);
    if (!duplicated.ok) return;
    expect(duplicated.value.state.pages['copied-note']?.calculatedResultBackground).toBe(false);
  });

  it('preserves explicit and legacy choices when pages are imported', () => {
    const imported = applyCommand(emptyWorkspace(), {
      type: 'pages.insert',
      pages: [
        newPageMeta({ id: 'imported-off', parentId: null, calculatedResultBackground: false }),
        newPageMeta({ id: 'imported-legacy', parentId: null }),
      ],
      docs: { 'imported-off': emptyDoc(), 'imported-legacy': emptyDoc() },
    });
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.value.state.pages['imported-off']?.calculatedResultBackground).toBe(false);
    expect(imported.value.state.pages['imported-legacy']?.calculatedResultBackground).toBeNull();

    const parsedBackup = parseBackup(JSON.stringify(createBackup(imported.value.state, new Date(0))));
    expect(parsedBackup.ok).toBe(true);
    if (!parsedBackup.ok) return;
    expect(parsedBackup.value.pages.find((page) => page.id === 'imported-off')?.calculatedResultBackground).toBe(false);
    expect(parsedBackup.value.pages.find((page) => page.id === 'imported-legacy')?.calculatedResultBackground).toBeNull();
  });
});
