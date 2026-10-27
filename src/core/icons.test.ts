import { describe, expect, it } from 'vitest';
import { encodeFileIcon, encodeLucideIcon, parsePageIcon, sanitizeSvg, validPageIcon } from './icons';

describe('page icon values', () => {
  it('keeps emoji values compatible and round-trips colored Lucide and local file icons', () => {
    expect(parsePageIcon('📚')).toEqual({ kind: 'emoji', value: '📚' });
    expect(parsePageIcon(encodeLucideIcon('BookOpen', '#ffffff'))).toEqual({
      kind: 'lucide',
      name: 'BookOpen',
      color: '#FFFFFF',
    });
    expect(parsePageIcon(encodeFileIcon('attachments/my icon.svg', '#aabbcc'))).toEqual({
      kind: 'file',
      id: 'attachments/my icon.svg',
      color: '#AABBCC',
    });
  });

  it('rejects malformed values and attachment paths outside the icon folder', () => {
    expect(encodeFileIcon('attachments/../secret.svg')).toBeNull();
    expect(parsePageIcon('morrow-icon:file:%2E%2E%2Fsecret.svg')).toBeNull();
    expect(parsePageIcon('morrow-icon:lucide:not-an-icon')).toBeNull();
    expect(validPageIcon('📝')).toBe(true);
    expect(validPageIcon('this emoji string is too long')).toBe(false);
  });
});

describe('SVG icon sanitizing', () => {
  it('preserves the source appearance when no recolor was chosen', () => {
    const safe = sanitizeSvg(
      '<svg viewBox="0 0 24 24" fill="#123456"><path d="M2 2L22 22" stroke="#abcdef"/></svg>',
    );
    expect(safe).toContain('fill="#123456"');
    expect(safe).toContain('stroke="#abcdef"');
    expect(safe).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('recolors vector paint only when an explicit color is selected', () => {
    const line = sanitizeSvg(
      '<svg viewBox="0 0 24 24"><path d="M2 2L22 22" stroke="#abcdef"/></svg>',
      '#ff0000',
    );
    expect(line).toContain('fill="none"');
    expect(line).toContain('stroke="currentColor"');
    const filled = sanitizeSvg(
      '<svg viewBox="0 0 24 24" fill="#123456"><path d="M2 2L22 22"/></svg>',
      '#ff0000',
    );
    expect(filled).toContain('fill="currentColor"');
  });

  it('drops event and style attributes, rejects scripts, and refuses external paint references', () => {
    const safe = sanitizeSvg(
      '<svg viewBox="0 0 24 24" onload="alert(1)" style="color:red"><path d="M1 1L2 2"/></svg>',
    );
    expect(safe).not.toContain('onload');
    expect(safe).not.toContain('style=');
    expect(sanitizeSvg('<svg><script>alert(1)</script></svg>')).toBeNull();
    expect(
      sanitizeSvg('<svg><path d="M1 1L2 2" fill="url(https://example.com/a.svg#paint)"/></svg>'),
    ).toBeNull();
  });
});
