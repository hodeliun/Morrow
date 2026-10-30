import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

it('keeps pins before new tabs and protects them from direct and batch closing', async () => {
  vi.resetModules();
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
  });
  vi.stubGlobal('window', {
    location: { hash: '#/page/a' },
    history: { replaceState: vi.fn() },
    addEventListener: vi.fn(),
  });
  const tabs = await import('./tabs');
  const first = tabs.getTabs().active;
  tabs.openTab('#/page/b');
  const second = tabs.getTabs().active;
  tabs.setTabPinned(first, true);
  tabs.setTabPinned(second, true);
  tabs.activateTab(first);
  tabs.openTab('#/page/c');
  const third = tabs.getTabs().active;
  expect(tabs.getTabs().tabs.map((tab) => tab.id)).toEqual([first, second, third]);
  tabs.closeTab(first);
  expect(tabs.getTabs().tabs).toHaveLength(3);
  tabs.closeTabsToRight(first);
  expect(tabs.getTabs().tabs.map((tab) => tab.id)).toEqual([first, second]);
  tabs.openTab('#/page/d');
  tabs.closeOtherTabs(first);
  expect(tabs.getTabs().tabs.map((tab) => tab.id)).toEqual([first, second]);
  tabs.setTabPinned(second, false);
  tabs.closeTab(second);
  expect(tabs.getTabs().tabs.map((tab) => tab.id)).toEqual([first]);
});
