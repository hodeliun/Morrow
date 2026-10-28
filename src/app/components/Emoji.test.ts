import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { encodeFileIcon, encodeLucideIcon } from '../../core/icons';
import { LUCIDE_ICON_NAMES, PageGlyph } from './Emoji';
import { preparePageIconFile } from './EmojiPicker';
import { PropertyGlyph } from './database/PropertyTypeSelect';

describe('page icon renderer', () => {
  it('renders recolorable Lucide icons as inline SVG for page chrome and links', () => {
    const markup = renderToStaticMarkup(
      createElement(PageGlyph, {
        icon: encodeLucideIcon('BookOpen', '#22c55e')!,
        className: 'page-link-icon',
      }),
    );
    expect(markup).toContain('<svg');
    expect(markup).toContain('color:#22C55E');
    expect(markup).toContain('page-link-icon');
    expect(LUCIDE_ICON_NAMES.length).toBeGreaterThan(1500);
    expect(LUCIDE_ICON_NAMES).toContain('BookOpen');
  });

  it.each([14, 32])('fits uploaded raster and SVG glyphs inside a %ipx property slot', (size) => {
    for (const fileName of ['portrait-200x400.png', 'portrait-200x400.svg']) {
      const icon = encodeFileIcon(`attachments/${fileName}`)!;
      const markup = renderToStaticMarkup(
        createElement(PropertyGlyph, { prop: { type: 'image', icon }, size }),
      );
      expect(markup).toContain(`style="width:${size}px;height:${size}px;object-fit:contain"`);
    }
  });

  it('leaves page-level custom glyph sizing to its existing CSS contexts', () => {
    const icon = encodeFileIcon('attachments/page-icon.png')!;
    const markup = renderToStaticMarkup(createElement(PageGlyph, { icon }));
    expect(markup).toContain('icon-loading');
    expect(markup).not.toContain('style=');
  });

  it('accepts recognized raster bytes and sanitizes SVG before a vault write', async () => {
    const jpeg = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], 'cover.jpg', { type: 'image/jpeg' });
    const accepted = await preparePageIconFile(jpeg);
    expect(accepted?.type).toBe('image/jpeg');
    const png = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'cover.png', {
      type: 'image/png',
    });
    const webp = new File(
      [new Uint8Array([...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')])],
      'cover.webp',
      { type: 'image/webp' },
    );
    expect((await preparePageIconFile(png))?.type).toBe('image/png');
    expect((await preparePageIconFile(webp))?.type).toBe('image/webp');

    const svg = new File(
      ['<svg viewBox="0 0 24 24" onload="alert(1)"><path d="M1 1L2 2"/></svg>'],
      'folder.svg',
      { type: 'image/svg+xml' },
    );
    const safe = await preparePageIconFile(svg);
    expect(safe?.type).toBe('image/svg+xml');
    expect(await safe?.text()).not.toContain('onload');

    const fake = new File(['not an image'], 'fake.png', { type: 'image/png' });
    expect(await preparePageIconFile(fake)).toBeNull();
    const script = new File(['<svg><script>alert(1)</script></svg>'], 'bad.svg', { type: 'image/svg+xml' });
    expect(await preparePageIconFile(script)).toBeNull();
  });
});
