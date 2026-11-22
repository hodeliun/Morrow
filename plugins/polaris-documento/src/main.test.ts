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
  return [...style.sheet.cssRules].filter((rule): rule is CSSStyleRule => 'selectorText' in rule);
}

function matchingRules(
  element: { matches(selector: string): boolean },
  rules: CSSStyleRule[],
): CSSStyleRule[] {
  return rules.filter((rule) =>
    rule.selectorText.split(',').some((selector) => {
      try {
        return element.matches(selector.trim());
      } catch {
        return false;
      }
    }),
  );
}

function rule(rules: CSSStyleRule[], selector: string): CSSStyleRule {
  const found = rules.find((candidate) =>
    candidate.selectorText.split(',').some((candidateSelector) => candidateSelector.trim() === selector),
  );
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

  it('styles host page-link and relation states while leaving external anchors and actions untouched', () => {
    const window = new Window({ url: 'http://morrow.test/' });
    windows.push(window);
    const { api } = stylesHarness(window);
    const root = window.document.createElement('div');
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
    expect(root.innerHTML).toBe(originalMarkup);

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
