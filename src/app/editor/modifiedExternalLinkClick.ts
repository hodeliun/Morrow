import type { EditorView } from '@tiptap/pm/view';

interface LinkElementLike {
  href?: unknown;
}

interface ElementLike {
  closest?: (selector: string) => LinkElementLike | null;
  parentElement?: ElementLike | null;
}

export function hasHttpExternalScheme(href: unknown): href is string {
  return typeof href === 'string' && /^https?:/i.test(href);
}

function validExternalHttpHref(href: unknown): string | null {
  if (!hasHttpExternalScheme(href)) return null;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function anchorFromClick(event: MouseEvent): LinkElementLike | null {
  const targets = [event.target, ...event.composedPath()];
  for (const target of targets) {
    let element = target as ElementLike | null;
    while (element) {
      if (typeof element.closest === 'function') {
        const anchor = element.closest('a[href]');
        if (anchor) return anchor;
      }
      element = element.parentElement ?? null;
    }
  }
  return null;
}

export function handleModifiedExternalLinkClick(
  view: Pick<EditorView, 'dom'>,
  event: MouseEvent,
  openHref: (href: string) => void,
): boolean {
  if (
    event.type !== 'click' ||
    event.defaultPrevented ||
    event.button !== 0 ||
    !(event.ctrlKey || event.metaKey)
  )
    return false;

  const anchor = anchorFromClick(event);
  if (!anchor || !view.dom.contains(anchor as Node)) return false;
  const href = validExternalHttpHref(anchor.href);
  if (!href) return false;

  event.preventDefault();
  openHref(href);
  return true;
}
