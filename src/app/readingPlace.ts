import type { PageId } from '../core/model';

export interface ReadingPlace {
  scroll: number;
  from: number;
  to: number;
}

export interface ReadingScope {
  tabId: string;
  pane: string;
  pageId: PageId;
  vaultKey?: string;
}

const KEY = 'morrow.readingPlaces.v2';
const LEGACY_KEY = 'morrow.readingPlaces';
const MAX_PAGES = 300;
const MAX_SCOPES = 1200;
let vaultKey = '';
let places: Map<string, ReadingPlace> | null = null;
const scopes = new Map<string, { scope: ReadingScope; place: ReadingPlace }>();
const claimedPages = new Set<string>();
let writable = true;
let legacyPending = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function pageKey(id: PageId, vault = vaultKey): string {
  return JSON.stringify([vault, id]);
}

function scopeKey(scope: ReadingScope): string {
  return JSON.stringify([scope.vaultKey ?? vaultKey, scope.tabId, scope.pane, scope.pageId]);
}

function validPlace(value: unknown): value is ReadingPlace {
  if (!value || typeof value !== 'object') return false;
  const { scroll, from, to } = value as Partial<ReadingPlace>;
  return (
    typeof scroll === 'number' &&
    Number.isFinite(scroll) &&
    scroll >= 0 &&
    typeof from === 'number' &&
    Number.isSafeInteger(from) &&
    from >= 0 &&
    typeof to === 'number' &&
    Number.isSafeInteger(to) &&
    to >= 0
  );
}

function load(): Map<string, ReadingPlace> {
  if (places) return places;
  places = new Map();
  try {
    const text = localStorage.getItem(KEY);
    if (!text) {
      legacyPending = true;
      return places;
    }
    const raw: unknown = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || (raw as { version?: unknown }).version !== 2) {
      writable = false;
      return places;
    }
    const entries = (raw as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) {
      writable = false;
      return places;
    }
    for (const entry of entries.slice(-MAX_PAGES)) {
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        typeof entry[0] !== 'string' ||
        !validPlace(entry[1])
      )
        continue;
      const key: unknown = JSON.parse(entry[0]);
      if (Array.isArray(key) && key.length === 2 && key.every((part) => typeof part === 'string'))
        places.set(entry[0], { ...entry[1] });
    }
  } catch {
    // Unreadable or future storage remains untouched; this window still works in memory.
    writable = false;
  }
  return places;
}

export function setReadingVaultScope(next: string): void {
  flushPlaces();
  vaultKey = next;
  const all = load();
  if (!legacyPending || !next) return;
  legacyPending = false;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [id, place] of Object.entries(raw).slice(-MAX_PAGES))
      if (validPlace(place)) all.set(pageKey(id), { ...place });
    // Legacy page-only data is assigned once to the first vault, never replayed into another vault.
    if (all.size > 0) timer ??= setTimeout(save, 400);
  } catch {
    // A broken legacy entry does not replace versioned storage.
  }
}

function save(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const all = load();
  if (!writable) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: 2, entries: [...all] }));
  } catch {
    // Storage may be unavailable. Session positions remain usable.
  }
}

export function readingPlace(id: PageId): ReadingPlace | null {
  return load().get(pageKey(id)) ?? null;
}

export function rememberPlace(id: PageId, change: Partial<ReadingPlace>): void {
  rememberDurable(id, vaultKey, change);
}

function rememberDurable(id: PageId, vault: string, change: Partial<ReadingPlace>): void {
  const all = load();
  const key = pageKey(id, vault);
  const next = { scroll: 0, from: 0, to: 0, ...all.get(key), ...change };
  if (!validPlace(next)) return;
  all.delete(key);
  all.set(key, next);
  while (all.size > MAX_PAGES) all.delete(all.keys().next().value!);
  timer ??= setTimeout(save, 400);
}

export function sessionReadingPlace(scope: ReadingScope): ReadingPlace | undefined {
  return scopes.get(scopeKey(scope))?.place;
}

// Persistent page/cursor data seeds the first live context. A second tab showing the same page is
// independent; it must not inherit scrolling or selection from an already mounted tab.
export function resolveReadingPlace(scope: ReadingScope): ReadingPlace | null {
  const existing = sessionReadingPlace(scope);
  if (existing) return existing;
  const page = pageKey(scope.pageId, scope.vaultKey ?? vaultKey);
  const durable = claimedPages.has(page) ? null : (load().get(page) ?? null);
  claimedPages.add(page);
  const place = durable ? { ...durable } : { scroll: 0, from: 0, to: 0 };
  scopes.set(scopeKey(scope), { scope: { ...scope, vaultKey: scope.vaultKey ?? vaultKey }, place });
  return place;
}

export function rememberScopedPlace(scope: ReadingScope, change: Partial<ReadingPlace>): void {
  if (change.scroll !== undefined && (!Number.isFinite(change.scroll) || change.scroll < 0)) return;
  if (change.from !== undefined && (!Number.isSafeInteger(change.from) || change.from < 0)) return;
  if (change.to !== undefined && (!Number.isSafeInteger(change.to) || change.to < 0)) return;
  const previous = sessionReadingPlace(scope) ?? resolveReadingPlace(scope);
  const place = { scroll: 0, from: 0, to: 0, ...previous, ...change };
  if (!validPlace(place)) return;
  const key = scopeKey(scope);
  scopes.delete(key);
  scopes.set(key, { scope: { ...scope, vaultKey: scope.vaultKey ?? vaultKey }, place });
  while (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value!);
  rememberDurable(scope.pageId, scope.vaultKey ?? vaultKey, place);
}

export function forgetReadingTab(tabId: string): void {
  for (const [key, entry] of scopes)
    if (entry.scope.tabId === tabId && entry.scope.vaultKey === vaultKey) scopes.delete(key);
}

export function flushPlaces(): void {
  if (timer) save();
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', flushPlaces);
