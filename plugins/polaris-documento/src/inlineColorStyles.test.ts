import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { activate, type PolarisDocumentoApi } from './main';

const windows: Window[] = [];
type StyleRule = {
  selectorText: string;
  style: { getPropertyValue(property: string): string; readonly length: number };
};

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()));
});

function addStyle(window: Window, css: string): () => void {
  const style = window.document.createElement('style');
  style.textContent = css;
  window.document.head.append(style);
  return () => style.remove();
}

function nativeStyles(window: Window): void {
  const root = resolve(import.meta.dirname, '../../../src/app/styles');
  for (const file of ['tokens.css', 'editor.css', 'color.css'])
    addStyle(window, readFileSync(resolve(root, file), 'utf8'));
}

function activateDocumento(window: Window): () => void {
  const api: PolarisDocumentoApi = {
    styles: { add: (css) => addStyle(window, css) },
    editor: { inlineColorControl: { add: () => () => {} } },
  };
  return activate(api);
}

describe('Polaris Documento heading inheritance', () => {
  it.each(['light', 'dark'])('restores theme inheritance in %s colorful mode and removes it on disable', (theme) => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    nativeStyles(window);
    const { document } = window;
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.colorful = 'true';

    const prose = document.createElement('div');
    prose.className = 'prose';
    prose.innerHTML = `
      <h1><span style="color: #12ab34">Custom H1</span></h1>
      <h2>H2</h2>
      <h3>H3</h3>
      <h4>H4</h4>
      <h5>H5</h5>
      <h6>H6</h6>
    `;
    document.body.append(prose);

    const inheritedColor = window.getComputedStyle(prose).color;
    const nativeAccent = window.getComputedStyle(prose.querySelector('h1')!).color;
    expect(nativeAccent).not.toBe(inheritedColor);

    const nativeColorRules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]) as unknown as StyleRule[];
    const h2Accent = nativeColorRules.find(
      (rule) => rule.selectorText === ":root[data-colorful='true'] .prose h2::before",
    );
    expect(h2Accent?.style.getPropertyValue('background')).toBe('var(--accent)');

    const disable = activateDocumento(window);
    const headings = [...prose.querySelectorAll('h1, h2, h3, h4, h5, h6')];
    expect(window.getComputedStyle(prose.querySelector('h1 span')!).color).toBe('#12ab34');

    const pluginStyles = [...document.querySelectorAll('style')].filter((style) =>
      style.textContent?.includes("color: inherit;") && style.textContent.includes('.color-custom-control'),
    );
    expect(pluginStyles).toHaveLength(1);
    const reset = ([...pluginStyles[0]!.sheet!.cssRules] as unknown as StyleRule[]).find((rule) =>
      rule.selectorText.includes('.prose h1'),
    );
    expect(reset?.style.getPropertyValue('color')).toBe('inherit');
    expect(reset?.style.length).toBe(1);
    const resetSelectors = reset?.selectorText.split(',').map((selector) => selector.trim()) ?? [];
    for (const heading of headings)
      expect(resetSelectors.some((selector) => heading.matches(selector))).toBe(true);

    disable();
    expect(window.getComputedStyle(prose.querySelector('h1')!).color).toBe(nativeAccent);
    expect(window.getComputedStyle(prose.querySelector('h2')!).color).toBe(inheritedColor);
    expect(h2Accent?.style.getPropertyValue('background')).toBe('var(--accent)');
    expect(window.getComputedStyle(prose.querySelector('h1 span')!).color).toBe('#12ab34');
  });

  it.each(['light', 'dark'])('restores neutral H6 theme color in %s mode only while Documento is active', (theme) => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    nativeStyles(window);
    const { document } = window;
    document.documentElement.dataset.theme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.colorful = 'false';

    const prose = document.createElement('div');
    prose.className = 'prose';
    prose.innerHTML = '<h6><span style="color: #12ab34">Custom H6</span></h6>';
    document.body.append(prose);

    const heading = prose.querySelector('h6')!;
    const inheritedColor = window.getComputedStyle(prose).color;
    const nativeH6 = window.getComputedStyle(heading).color;
    expect(nativeH6).not.toBe(inheritedColor);
    expect(window.getComputedStyle(heading.querySelector('span')!).color).toBe('#12ab34');

    const disable = activateDocumento(window);
    const pluginStyle = [...document.querySelectorAll('style')].find((style) =>
      style.textContent?.includes('.color-custom-control') && style.textContent.includes('.prose h6'),
    );
    const h6Reset = ([...(pluginStyle?.sheet?.cssRules ?? [])] as unknown as StyleRule[]).find(
      (rule) => rule.selectorText === '.prose h6',
    );
    expect(h6Reset?.style.getPropertyValue('color')).toBe('inherit');
    expect(h6Reset?.style.length).toBe(1);
    expect(window.getComputedStyle(heading.querySelector('span')!).color).toBe('#12ab34');

    disable();
    expect(window.getComputedStyle(heading).color).toBe(nativeH6);
    expect(window.getComputedStyle(heading.querySelector('span')!).color).toBe('#12ab34');
  });
});
