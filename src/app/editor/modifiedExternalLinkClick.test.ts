import { describe, expect, it } from 'vitest';
import type { EditorView } from '@tiptap/pm/view';
import { handleModifiedExternalLinkClick, hasHttpExternalScheme } from './modifiedExternalLinkClick';

const externalUrl = 'https://example.test/path';

function setupClick(
  options: {
    href?: string;
    button?: number;
    ctrlKey?: boolean;
    metaKey?: boolean;
    defaultPrevented?: boolean;
    insideEditor?: boolean;
    targetMode?: 'element' | 'text' | 'missing-link';
  } = {},
) {
  const anchor = {
    href: options.href ?? externalUrl,
    closest: (selector: string) => (selector === 'a[href]' ? anchor : null),
  };
  const child = {
    closest: (selector: string) =>
      options.targetMode === 'missing-link' || selector !== 'a[href]' ? null : anchor,
  };
  const textNode = { parentElement: child };
  const target = options.targetMode === 'text' ? textNode : child;
  const preventDefaultCalls = { count: 0 };
  let prevented = options.defaultPrevented ?? false;
  const event = {
    type: 'click',
    button: options.button ?? 0,
    ctrlKey: options.ctrlKey ?? true,
    metaKey: options.metaKey ?? false,
    target,
    composedPath: () => (options.targetMode === 'missing-link' ? [target] : [target, anchor]),
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
      preventDefaultCalls.count += 1;
    },
  } as unknown as MouseEvent;
  const editorDom = {
    contains: (node: Node) => options.insideEditor !== false && node === (anchor as unknown as Node),
  };
  const document = Object.freeze({
    type: 'doc',
    content: Object.freeze([
      { type: 'paragraph', content: Object.freeze([{ type: 'text', text: 'saved' }]) },
    ]),
  });
  let dispatchCalls = 0;
  const view = {
    dom: editorDom,
    editable: false,
    state: { doc: document },
    dispatch: () => {
      dispatchCalls += 1;
    },
  } as unknown as EditorView;
  return { anchor, dispatchCalls: () => dispatchCalls, document, event, preventDefaultCalls, view };
}

describe('modified external link clicks', () => {
  it('dispatches one HTTP link click from the actual anchor and leaves a read-only document unchanged', () => {
    const click = setupClick({ targetMode: 'text' });
    const opened: string[] = [];

    expect(handleModifiedExternalLinkClick(click.view, click.event, (href) => opened.push(href))).toBe(true);
    expect(click.event.defaultPrevented).toBe(true);
    expect(click.preventDefaultCalls.count).toBe(1);
    expect(opened).toEqual([externalUrl]);
    expect(click.view.state.doc).toBe(click.document);
    expect(click.dispatchCalls()).toBe(0);

    // repeated delivery of the already-prevented DOM event is ignored
    expect(handleModifiedExternalLinkClick(click.view, click.event, (href) => opened.push(href))).toBe(false);
    expect(opened).toEqual([externalUrl]);
  });

  it('accepts Meta-click on an HTTP(S) anchor', () => {
    const click = setupClick({ ctrlKey: false, metaKey: true });
    const opened: string[] = [];

    expect(handleModifiedExternalLinkClick(click.view, click.event, (href) => opened.push(href))).toBe(true);
    expect(opened).toEqual([externalUrl]);
    expect(click.event.defaultPrevented).toBe(true);
  });

  it.each([
    ['plain click', { ctrlKey: false }],
    ['middle button', { button: 1 }],
    ['already prevented event', { defaultPrevented: true }],
    ['anchor outside editor', { insideEditor: false }],
    ['no anchor', { targetMode: 'missing-link' as const }],
    ['internal page link', { href: '#/page/target' }],
    ['mailto link', { href: 'mailto:test@example.test' }],
    ['unsupported scheme', { href: 'javascript:alert(1)' }],
    ['malformed HTTP URL', { href: 'https://' }],
  ])('leaves %s to its existing handler', (_description, options) => {
    const click = setupClick(options);
    let calls = 0;

    expect(handleModifiedExternalLinkClick(click.view, click.event, () => (calls += 1))).toBe(false);
    expect(calls).toBe(0);
    const expectedDefaultPrevented = 'defaultPrevented' in options ? options.defaultPrevented : false;
    expect(click.event.defaultPrevented).toBe(expectedDefaultPrevented);
  });

  it('classifies HTTP(S) link marks so the earlier handleClickOn path can defer them', () => {
    expect(hasHttpExternalScheme('https://example.test')).toBe(true);
    expect(hasHttpExternalScheme('HTTP://example.test')).toBe(true);
    expect(hasHttpExternalScheme('https://')).toBe(true);
    expect(hasHttpExternalScheme('#/page/target')).toBe(false);
    expect(hasHttpExternalScheme('mailto:test@example.test')).toBe(false);
    expect(hasHttpExternalScheme(undefined)).toBe(false);
  });
});
