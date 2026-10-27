import { describe, expect, it } from 'vitest';
import { contrastTextForHex } from './colorContrast';

describe('contrastTextForHex', () => {
  it('uses dark text on a light custom block background', () => {
    expect(contrastTextForHex('#aabbcc')).toBe('#111111');
    expect(contrastTextForHex('#ffffff')).toBe('#111111');
  });

  it('uses light text on a dark custom block background', () => {
    expect(contrastTextForHex('#112233')).toBe('#ffffff');
    expect(contrastTextForHex('#000000')).toBe('#ffffff');
  });
});
