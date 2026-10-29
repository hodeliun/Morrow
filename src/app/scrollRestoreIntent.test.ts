import { describe, expect, it } from 'vitest';
import {
  shouldCancelPendingScrollRestoreForKeyboard,
  shouldCancelPendingScrollRestoreForPointer,
} from './scrollRestoreIntent';

const pointerIntent = (
  overrides: Partial<Parameters<typeof shouldCancelPendingScrollRestoreForPointer>[0]> = {},
) => ({
  isTrusted: true,
  targetIsPageContent: false,
  targetIsNavigationControl: false,
  targetIsInteractiveControl: false,
  inScrollbarGutter: false,
  ...overrides,
});

const keyboardIntent = (
  overrides: Partial<Parameters<typeof shouldCancelPendingScrollRestoreForKeyboard>[0]> = {},
) => ({
  eventType: 'keydown' as const,
  isTrusted: true,
  key: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  altGraph: false,
  isComposing: false,
  targetCanEdit: false,
  targetIsTextControl: false,
  targetPreventsPageScroll: false,
  ...overrides,
});

describe('pending page-scroll restoration intent', () => {
  it('cancels for real pointer input in page content, controls, or the scrollbar', () => {
    expect(shouldCancelPendingScrollRestoreForPointer(pointerIntent({ targetIsPageContent: true }))).toBe(
      true,
    );
    expect(
      shouldCancelPendingScrollRestoreForPointer(pointerIntent({ targetIsNavigationControl: true })),
    ).toBe(true);
    expect(shouldCancelPendingScrollRestoreForPointer(pointerIntent({ inScrollbarGutter: true }))).toBe(true);
    expect(
      shouldCancelPendingScrollRestoreForPointer(pointerIntent({ targetIsInteractiveControl: true })),
    ).toBe(true);
  });

  it('ignores synthetic pointer events on controls and pointer input outside content', () => {
    expect(
      shouldCancelPendingScrollRestoreForPointer(
        pointerIntent({ isTrusted: false, targetIsInteractiveControl: true }),
      ),
    ).toBe(false);
    expect(shouldCancelPendingScrollRestoreForPointer(pointerIntent())).toBe(false);
  });

  it('cancels before keyboard editing starts in the editor or a text control', () => {
    for (const key of ['a', 'F2', 'Enter']) {
      expect(
        shouldCancelPendingScrollRestoreForKeyboard(keyboardIntent({ key, targetCanEdit: key === 'a' })),
      ).toBe(true);
    }
    expect(
      shouldCancelPendingScrollRestoreForKeyboard(keyboardIntent({ key: 'x', targetIsTextControl: true })),
    ).toBe(true);
    expect(
      shouldCancelPendingScrollRestoreForKeyboard(
        keyboardIntent({ eventType: 'compositionstart', targetCanEdit: true }),
      ),
    ).toBe(true);
    expect(
      shouldCancelPendingScrollRestoreForKeyboard(
        keyboardIntent({ key: 'Process', isComposing: true, targetIsTextControl: true }),
      ),
    ).toBe(true);
  });

  it('preserves scroll keys but leaves input-local arrows to their control', () => {
    expect(shouldCancelPendingScrollRestoreForKeyboard(keyboardIntent({ key: 'PageDown' }))).toBe(true);
    expect(
      shouldCancelPendingScrollRestoreForKeyboard(
        keyboardIntent({ key: 'ArrowDown', targetPreventsPageScroll: true }),
      ),
    ).toBe(false);
  });

  it('does not mistake focus traversal or global shortcuts for viewport intent', () => {
    for (const key of ['Tab', 'f']) {
      expect(
        shouldCancelPendingScrollRestoreForKeyboard(
          keyboardIntent({ key, ctrlKey: key === 'f', targetCanEdit: true }),
        ),
      ).toBe(false);
    }
    expect(
      shouldCancelPendingScrollRestoreForKeyboard(
        keyboardIntent({ key: 'Tab', ctrlKey: true, targetCanEdit: true }),
      ),
    ).toBe(false);
    expect(
      shouldCancelPendingScrollRestoreForKeyboard(
        keyboardIntent({ key: 'b', targetCanEdit: true, isTrusted: false }),
      ),
    ).toBe(false);
  });
});
