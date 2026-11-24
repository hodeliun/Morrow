// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { act, createElement, Fragment, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { WorkspaceSession } from '../storage/session';
import { cacheablePaneHostIds, paneHostChildren, paneHostInstances } from './App';

function session(): WorkspaceSession {
  return {} as WorkspaceSession;
}

describe('visible pane host cache', () => {
  it('mounts only the visible instances, retains them while registered, and prunes closed tabs', () => {
    const workspace = session();
    expect(paneHostInstances(workspace, ['main', 'side', 'background'], ['main', 'side'])).toEqual([
      'main',
      'side',
    ]);

    expect(paneHostInstances(workspace, ['main', 'side', 'background'], ['background'])).toEqual([
      'main',
      'side',
      'background',
    ]);
    expect(paneHostInstances(workspace, ['side', 'background'], ['background'])).toEqual([
      'side',
      'background',
    ]);
  });

  it('keeps the host cache isolated by workspace session', () => {
    const first = session();
    const second = session();
    paneHostInstances(first, ['first-main', 'first-side'], ['first-main', 'first-side']);

    expect(paneHostInstances(second, ['second-main', 'second-background'], ['second-main'])).toEqual([
      'second-main',
    ]);
  });

  it('keeps keyed pane hosts mounted while moving between visible and hidden positions', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const mounts = new Map<string, number>();
    const unmounts = new Map<string, number>();
    const PaneProbe = ({ id, hidden }: { id: string; hidden: boolean }) => {
      useEffect(() => {
        mounts.set(id, (mounts.get(id) ?? 0) + 1);
        return () => {
          unmounts.set(id, (unmounts.get(id) ?? 0) + 1);
        };
      }, [id]);
      return createElement('section', { 'data-pane-probe': id, hidden }, id);
    };
    const children = (visible: string[], hidden: string[]) =>
      paneHostChildren(
        7,
        visible.map((id) => ({ tabId: id, element: createElement(PaneProbe, { id, hidden: false }) })),
        hidden.map((id) => ({ tabId: id, element: createElement(PaneProbe, { id, hidden: true }) })),
        createElement(
          Fragment,
          null,
          ...['root', 'left', 'right'].map((id) =>
            createElement('div', { key: id, 'data-split-resizer': id }),
          ),
        ),
      );
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () => root.render(createElement(Fragment, null, ...children(['main', 'side'], []))));
      expect(mounts.get('main')).toBe(1);
      expect(mounts.get('side')).toBe(1);
      expect(container.querySelectorAll('[data-split-resizer]')).toHaveLength(3);
      expect(container.querySelector('[data-pane-probe="main"]')?.parentElement).toBe(container);
      expect(container.querySelector('[data-split-resizer="right"]')?.parentElement).toBe(container);

      await act(async () =>
        root.render(createElement(Fragment, null, ...children(['side', 'other'], ['main']))),
      );
      expect(container.querySelector<HTMLElement>('[data-pane-probe="main"]')?.hidden).toBe(true);
      expect(mounts.get('main')).toBe(1);
      expect(unmounts.get('main') ?? 0).toBe(0);

      await act(async () =>
        root.render(createElement(Fragment, null, ...children(['main', 'side'], ['other']))),
      );
      expect(container.querySelector<HTMLElement>('[data-pane-probe="main"]')?.hidden).toBe(false);
      expect(mounts.get('main')).toBe(1);
      expect(mounts.get('side')).toBe(1);
      expect(unmounts.get('main') ?? 0).toBe(0);
      expect(unmounts.get('side') ?? 0).toBe(0);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it('does not retain hidden Review routes, so their window shortcuts cannot keep running', () => {
    const workspace = session();
    const tabs = [
      { id: 'page', target: '#/page/note' },
      { id: 'review', target: '#/review/deck' },
      { id: 'active-page', target: '#/page/active' },
    ];
    const cacheable = cacheablePaneHostIds(tabs);
    expect(cacheable).toEqual(['page', 'active-page']);
    expect(
      paneHostInstances(
        workspace,
        tabs.map((tab) => tab.id),
        ['page', 'review'],
        cacheable,
      ),
    ).toEqual(['page']);

    const hiddenPageOnly = paneHostInstances(
      workspace,
      tabs.map((tab) => tab.id),
      ['active-page'],
      cacheable,
    );
    expect(hiddenPageOnly).toEqual(['page', 'active-page']);
    const visibleTabIds = new Set(['active-page']);
    const renderedHiddenIds = hiddenPageOnly.filter((tabId) => !visibleTabIds.has(tabId));
    expect(renderedHiddenIds).toEqual(['page']);
    expect(renderedHiddenIds).not.toContain('review');

    // When a page instance navigates to Review, the same id drops out of the cache immediately.
    expect(
      paneHostInstances(workspace, ['page'], [], cacheablePaneHostIds([{ id: 'page', target: '#/review' }])),
    ).toEqual([]);
  });
});
