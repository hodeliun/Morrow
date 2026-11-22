import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { activate, type PolarisDocumentoApi } from './main';

const windows: Window[] = [];

afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.abort()));
});

function stylesHarness(window: Window) {
  const add = vi.fn((css: string) => {
    const style = window.document.createElement('style');
    style.dataset.plugin = 'polaris-documento';
    style.textContent = css;
    window.document.head.append(style);
    let attached = true;
    return () => {
      if (!attached) return;
      attached = false;
      style.remove();
    };
  });
  return { api: { styles: { add } } as PolarisDocumentoApi, add };
}

function pluginRules(window: Window) {
  const style = window.document.querySelector(
    'style[data-plugin="polaris-documento"]',
  ) as unknown as HTMLStyleElement | null;
  if (!style?.sheet) throw new Error('The plugin style sheet was not installed.');
  const rules: CSSStyleRule[] = [];
  const collect = (list: CSSRuleList) => {
    for (const candidate of Array.from(list)) {
      if ('selectorText' in candidate) rules.push(candidate as CSSStyleRule);
      else if ('cssRules' in candidate) collect((candidate as CSSGroupingRule).cssRules);
    }
  };
  collect(style.sheet.cssRules);
  return rules;
}

function matchingRules(
  element: { matches(selector: string): boolean },
  rules: CSSStyleRule[],
): CSSStyleRule[] {
  return rules.filter((rule) => {
    try {
      return element.matches(rule.selectorText);
    } catch {
      return false;
    }
  });
}

function rule(rules: CSSStyleRule[], selector: string): CSSStyleRule {
  const found = rules.find((candidate) => candidate.selectorText.includes(selector));
  if (!found) throw new Error(`Missing plugin rule: ${selector}`);
  return found;
}

describe('Polaris Documento styles lifecycle', () => {
  it('adds one scoped style and removes it on disable and reload cleanup', () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const { api, add } = stylesHarness(window);

    const disable = activate(api);
    expect(add).toHaveBeenCalledOnce();
    expect(window.document.querySelectorAll('style[data-plugin="polaris-documento"]')).toHaveLength(1);

    disable();
    disable();
    expect(window.document.querySelectorAll('style[data-plugin="polaris-documento"]')).toHaveLength(0);

    const reload = activate(api);
    expect(add).toHaveBeenCalledTimes(2);
    expect(window.document.querySelectorAll('style[data-plugin="polaris-documento"]')).toHaveLength(1);
    reload();
    expect(window.document.querySelectorAll('style[data-plugin="polaris-documento"]')).toHaveLength(0);
  });

  it('styles host page-link and relation states while leaving external anchors and actions untouched', async () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    await window.happyDOM.setViewport({ width: 1440, height: 900 });
    const repositoryRoot = resolve(import.meta.dirname, '../../..');
    const hostStyles = window.document.createElement('style');
    hostStyles.textContent = ['src/app/styles/editor.css', 'src/app/styles/app.css']
      .map((path) => readFileSync(resolve(repositoryRoot, path), 'utf8'))
      .join('\n');
    window.document.head.append(hostStyles);
    const { api } = stylesHarness(window);
    const root = window.document.createElement('div');
    window.document.body.append(root);
    root.innerHTML = `
      <div class="prose">
        <a class="page-link" href="#/page/known" data-page-id="known">Resolved</a>
        <a class="page-link is-missing" href="#" data-page-id="">Missing</a>
        <a class="page-link is-unresolved" href="#" data-page-id="" title="Create page">Unresolved</a>
        <a class="external" href="https://example.test/">External</a>
      </div>
      <span role="link" tabindex="0" class="relation-chip" data-page-id="known">Related</span>
      <span role="link" tabindex="0" class="relation-chip is-missing">Gone</span>
    `;
    const originalMarkup = root.innerHTML;
    const dispose = activate(api);
    expect(window.document.querySelector('style[data-plugin="polaris-documento"]')?.textContent).toContain(
      '.prose a.page-link',
    );
    const rules = pluginRules(window);

    const resolved = root.querySelector('.prose a.page-link:not(.is-missing):not(.is-unresolved)')!;
    const missing = root.querySelector('.prose a.page-link.is-missing')!;
    const unresolved = root.querySelector('.prose a.page-link.is-unresolved')!;
    const external = root.querySelector('.prose a.external')!;
    const related = root.querySelector('.relation-chip:not(.is-missing)')!;
    const missingRelation = root.querySelector('.relation-chip.is-missing')!;

    expect(matchingRules(resolved, rules).map(({ selectorText }) => selectorText)).toContain(
      '.prose a.page-link',
    );
    expect(rule(rules, '.prose a.page-link:hover').style.getPropertyValue('background')).toBe('transparent');
    expect(matchingRules(missing, rules).map(({ selectorText }) => selectorText)).toContain(
      '.prose a.page-link.is-missing',
    );
    expect(rule(rules, '.prose a.page-link.is-missing').style.getPropertyValue('text-decoration-style')).toBe(
      'dotted',
    );
    expect(rule(rules, '.prose a.page-link.is-missing').style.getPropertyValue('text-decoration-line')).toBe(
      'underline',
    );
    expect(
      rule(rules, '.prose a.page-link.is-unresolved').style.getPropertyValue('border-bottom-width'),
    ).toBe('0px');
    expect(
      rule(rules, '.prose a.page-link.is-unresolved').style.getPropertyValue('text-decoration-style'),
    ).toBe('dashed');
    expect(
      rule(rules, '.prose a.page-link.is-unresolved:hover').style.getPropertyValue('text-decoration-color'),
    ).toBe('var(--accent)');
    expect(matchingRules(unresolved, rules).map(({ selectorText }) => selectorText)).toContain(
      '.prose a.page-link.is-unresolved',
    );
    expect(matchingRules(related, rules).map(({ selectorText }) => selectorText)).toContain('.relation-chip');
    expect(rule(rules, '.relation-chip.is-missing').style.getPropertyValue('text-decoration-style')).toBe(
      'dotted',
    );
    expect(matchingRules(missingRelation, rules).map(({ selectorText }) => selectorText)).toContain(
      '.relation-chip.is-missing',
    );
    expect(root.innerHTML).toBe(originalMarkup);

    const styledPage = window.document.createElement('article');
    styledPage.className = 'page font-mono width-full';
    styledPage.dataset.polarisNotePageId = 'styled-note';
    styledPage.dataset.polarisNoteStyle = 'saved';
    styledPage.dataset.polarisNoteFont = 'serif';
    styledPage.dataset.polarisNoteWidth = 'comfortable';
    styledPage.style.setProperty('--polaris-note-font-size', '19px');
    styledPage.style.setProperty('--polaris-note-line-height', '1.8');
    styledPage.style.setProperty('--polaris-note-block-spacing', '12px');
    styledPage.innerHTML =
      '<div class="prose"><h1>Serif heading</h1><p>Styled body</p></div><textarea class="page-title"></textarea>';
    const sansPage = window.document.createElement('article');
    sansPage.className = 'page font-mono width-wide';
    sansPage.dataset.polarisNotePageId = 'sans-note';
    sansPage.dataset.polarisNoteStyle = 'saved';
    sansPage.dataset.polarisNoteFont = 'sans';
    sansPage.dataset.polarisNoteWidth = 'wide';
    sansPage.innerHTML =
      '<div class="prose"><h2>Sans heading</h2><textarea class="page-title"></textarea></div>';
    const monoPage = window.document.createElement('article');
    monoPage.className = 'page font-sans width-comfortable';
    monoPage.dataset.polarisNotePageId = 'mono-note';
    monoPage.dataset.polarisNoteStyle = 'saved';
    monoPage.dataset.polarisNoteFont = 'mono';
    monoPage.dataset.polarisNoteWidth = 'full';
    monoPage.innerHTML =
      '<div class="prose"><h3>Mono heading</h3><textarea class="page-title"></textarea></div>';
    const narrowPane = window.document.createElement('section');
    narrowPane.className = 'pane';
    narrowPane.dataset.size = 'narrow';
    const narrowPage = window.document.createElement('article');
    narrowPage.className = 'page font-mono width-full';
    narrowPage.dataset.polarisNotePageId = 'narrow-note';
    narrowPage.dataset.polarisNoteStyle = 'saved';
    narrowPage.dataset.polarisNoteFont = 'serif';
    narrowPage.dataset.polarisNoteWidth = 'wide';
    narrowPage.innerHTML = '<textarea class="page-title"></textarea>';
    narrowPane.append(narrowPage);
    const unstyledPage = window.document.createElement('article');
    unstyledPage.className = 'page font-sans width-wide';
    unstyledPage.dataset.polarisNotePageId = 'native-note';
    unstyledPage.innerHTML =
      '<div class="prose"><h1>Native heading</h1><p>Native body</p><textarea class="page-title"></textarea></div>';
    root.append(styledPage, sansPage, monoPage, narrowPane, unstyledPage);

    const styledBody = styledPage.querySelector('.prose')!;
    const unstyledBody = unstyledPage.querySelector('.prose')!;
    expect(matchingRules(styledBody, rules).map(({ selectorText }) => selectorText)).toContain(
      '.page[data-polaris-note-page-id][data-polaris-note-style="saved"] .prose',
    );
    expect(
      rule(
        rules,
        '.page[data-polaris-note-page-id][data-polaris-note-style="saved"] .prose',
      ).style.getPropertyValue('font-size'),
    ).toContain('--polaris-note-font-size');
    expect(
      matchingRules(styledPage.querySelector('.page-title')!, rules).some(({ selectorText }) =>
        selectorText.includes('data-polaris-note-font="serif"'),
      ),
    ).toBe(true);
    expect(
      matchingRules(styledPage, rules).some(({ selectorText }) =>
        selectorText.includes('data-polaris-note-width="comfortable"'),
      ),
    ).toBe(true);
    expect(matchingRules(unstyledBody, rules)).toEqual([]);
    expect(styledPage.classList).toContain('font-mono');
    expect(styledPage.dataset.polarisNoteFont).toBe('serif');
    expect(styledPage.style.getPropertyValue('padding-left')).toBe('');
    expect(window.getComputedStyle(styledPage).paddingLeft).toBe('56px');
    expect(window.getComputedStyle(styledPage.querySelector('.page-title')!).fontWeight).toBe('700');
    expect(window.getComputedStyle(styledPage.querySelector('.page-title')!).fontSize).toContain('40px');
    expect(window.getComputedStyle(sansPage.querySelector('h2')!).fontWeight).toBe('700');
    expect(window.getComputedStyle(monoPage.querySelector('h3')!).fontWeight).toBe('650');
    expect(window.getComputedStyle(monoPage.querySelector('.page-title')!).fontSize).toContain('32px');
    expect(window.getComputedStyle(unstyledPage.querySelector('.page-title')!).fontWeight).toBe('600');
    expect(window.getComputedStyle(unstyledPage.querySelector('h1')!).fontWeight).toBe('700');
    expect(window.getComputedStyle(narrowPage).paddingLeft).toBe('28px');
    expect(window.getComputedStyle(narrowPage.querySelector('.page-title')!).fontSize).toContain('30px');

    const selectorForTitle = (font: string) =>
      `.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font="${font}"] .page-title`;
    const titleRules = {
      serif: rule(rules, selectorForTitle('serif')),
      sans: rule(rules, selectorForTitle('sans')),
      mono: rule(rules, selectorForTitle('mono')),
    };
    expect(titleRules.serif.style.getPropertyValue('font-size')).toContain('40px');
    expect(titleRules.serif.style.getPropertyValue('font-weight')).toBe('700');
    expect(titleRules.serif.style.getPropertyValue('letter-spacing')).toBe('-0.022em');
    expect(titleRules.sans.style.getPropertyValue('font-size')).toContain('40px');
    expect(titleRules.sans.style.getPropertyValue('font-weight')).toBe('600');
    expect(titleRules.sans.style.getPropertyValue('letter-spacing')).toBe('-0.02em');
    expect(titleRules.mono.style.getPropertyValue('font-size')).toContain('32px');
    expect(titleRules.mono.style.getPropertyValue('font-weight')).toBe('600');
    expect(titleRules.mono.style.getPropertyValue('letter-spacing')).toBe('-0.02em');
    expect(
      matchingRules(sansPage.querySelector('.page-title')!, rules).map(({ selectorText }) => selectorText),
    ).toContain(selectorForTitle('sans'));
    expect(
      matchingRules(monoPage.querySelector('.page-title')!, rules).map(({ selectorText }) => selectorText),
    ).toContain(selectorForTitle('mono'));

    const headingSelector = (font: string) =>
      `.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font="${font}"] .prose :is(h1, h2, h3, h4, h5, h6)`;
    const headingRules = {
      serif: rule(rules, headingSelector('serif')),
      sans: rule(rules, headingSelector('sans')),
    };
    expect(headingRules.serif.style.getPropertyValue('font-weight')).toBe('650');
    expect(headingRules.serif.style.getPropertyValue('letter-spacing')).toBe('-0.012em');
    expect(headingRules.sans.style.getPropertyValue('font-weight')).toBe('700');
    expect(headingRules.sans.style.getPropertyValue('letter-spacing')).toBe('-0.02em');
    expect(
      rules.find(
        ({ selectorText, style }) =>
          selectorText.includes(headingSelector('mono')) &&
          style.getPropertyValue('font-weight') === '650' &&
          style.getPropertyValue('letter-spacing') === '-0.012em',
      ),
    ).toBeDefined();
    expect(
      matchingRules(styledPage.querySelector('h1')!, rules).some(({ selectorText }) =>
        selectorText.includes(headingSelector('serif')),
      ),
    ).toBe(true);
    expect(
      matchingRules(sansPage.querySelector('h2')!, rules).some(({ selectorText }) =>
        selectorText.includes(headingSelector('sans')),
      ),
    ).toBe(true);
    expect(
      matchingRules(monoPage.querySelector('h3')!, rules).some(({ selectorText }) =>
        selectorText.includes(headingSelector('mono')),
      ),
    ).toBe(true);

    const widthSelector = (width: string) =>
      `.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-width="${width}"]`;
    expect(rule(rules, widthSelector('comfortable')).style.getPropertyValue('--page-width')).toBe('720px');
    expect(rule(rules, widthSelector('comfortable')).style.getPropertyValue('max-width')).toContain('112px');
    expect(rule(rules, widthSelector('wide')).style.getPropertyValue('--page-width')).toBe('980px');
    expect(rule(rules, widthSelector('full')).style.getPropertyValue('--page-width')).toBe('100%');
    expect(rule(rules, widthSelector('full')).style.getPropertyValue('max-width')).toBe('none');
    expect(
      rules.find(
        ({ selectorText, style }) =>
          selectorText === '.page[data-polaris-note-page-id][data-polaris-note-style="saved"]' &&
          style.getPropertyValue('padding-left') === '56px',
      ),
    ).toBeDefined();
    expect(
      rules.find(
        ({ selectorText, style }) =>
          selectorText ===
            '.pane[data-size="narrow"] .page[data-polaris-note-page-id][data-polaris-note-style="saved"]' &&
          style.getPropertyValue('padding-left') === '28px',
      ),
    ).toBeDefined();
    expect(
      rules.find(
        ({ selectorText, style }) =>
          selectorText === '.page[data-polaris-note-page-id][data-polaris-note-style="saved"]' &&
          style.getPropertyValue('padding-left') === '20px',
      ),
    ).toBeDefined();
    expect(
      rules.find(
        ({ selectorText, style }) =>
          selectorText ===
            '.pane[data-size="narrow"] .page[data-polaris-note-page-id][data-polaris-note-style="saved"] .page-title' &&
          style.getPropertyValue('font-size').includes('30px'),
      ),
    ).toBeDefined();
    expect(
      rules.find(
        ({ selectorText, style }) =>
          selectorText ===
            '.page[data-polaris-note-page-id][data-polaris-note-style="saved"][data-polaris-note-font] .page-title' &&
          style.getPropertyValue('font-size').includes('32px'),
      ),
    ).toBeDefined();
    expect(rule(rules, '.prose a.page-link:focus-visible').style.getPropertyValue('outline')).toContain(
      'var(--accent)',
    );
    expect(rule(rules, '.relation-chip:focus-visible').style.getPropertyValue('outline')).toContain(
      'var(--accent)',
    );
    expect(matchingRules(external, rules)).toEqual([]);

    expect(resolved.getAttribute('href')).toBe('#/page/known');
    expect(unresolved.getAttribute('href')).toBe('#');
    expect(related.getAttribute('role')).toBe('link');
    expect(related.getAttribute('tabindex')).toBe('0');
    dispose();
  });

  it('keeps the manifest, build command, and synthetic-vault installation paths aligned', () => {
    const pluginDir = resolve(import.meta.dirname, '..');
    const repositoryRoot = resolve(pluginDir, '../..');
    const manifest = JSON.parse(readFileSync(resolve(pluginDir, 'manifest.json'), 'utf8')) as {
      id: string;
    };
    const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    const readme = readFileSync(resolve(pluginDir, 'README.md'), 'utf8');

    expect(manifest.id).toBe('polaris-documento');
    expect(packageJson.scripts['build:polaris-documento']).toBe(
      'vite build --config plugins/polaris-documento/vite.config.ts',
    );
    expect(readme).toContain('npm run build:polaris-documento');
    expect(readme).toContain('dist/polaris-documento/main.js');
    expect(readme).toContain('.morrow/plugins/polaris-documento');
    expect(readme).toContain('.morrow/plugins.json');
    expect(readme).toContain('polaris-documento');
  });
});
