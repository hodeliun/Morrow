import { describe, expect, it } from 'vitest';
import { affectsImageFile } from './imageFileChanges';

describe('image file watcher changes', () => {
  it('matches only explicit changes for the viewed non-page resource path', () => {
    expect(
      affectsImageFile([{ path: 'Images/portrait.png', other: true, size: 2048 }], 'Images/portrait.png'),
    ).toBe(true);
    expect(
      affectsImageFile(
        [{ path: 'Images/portrait.png', text: null, other: true, dir: false, mtime: 10 }],
        'Images/portrait.png',
      ),
    ).toBe(true);
    expect(affectsImageFile([{ path: 'Images/other.png', other: true }], 'Images/portrait.png')).toBe(false);
    expect(affectsImageFile([{ path: 'Images/portrait.png', text: '# note' }], 'Images/portrait.png')).toBe(
      false,
    );
    expect(affectsImageFile([{ path: 'Images', other: true, dir: true }], 'Images/portrait.png')).toBe(false);
    expect(affectsImageFile(undefined, 'Images/portrait.png')).toBe(false);
  });

  it('invalidates a nested image when its containing folder is removed', () => {
    expect(
      affectsImageFile(
        [{ path: 'Images', text: null, other: true, dir: true }],
        'Images/portraits/portrait.png',
      ),
    ).toBe(true);
    expect(
      affectsImageFile([{ path: 'Images-old', text: null, other: true, dir: true }], 'Images/portrait.png'),
    ).toBe(false);
    expect(
      affectsImageFile([{ path: 'Images', text: '', other: true, dir: true }], 'Images/portrait.png'),
    ).toBe(false);
  });
});
