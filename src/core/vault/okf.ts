import { isRecord, walk } from '../doc';
import type { DocNode } from '../model';
import type { PageId, PageMeta, WorkspaceState } from '../model';
import { basename, dirname, resolveRelative } from './paths';

export type OkfDiagnostic =
  | {
      code:
        'missing-type' | 'invalid-type' | 'invalid-sources' | 'invalid-source-resource' | 'reserved-filename';
    }
  | { code: 'missing-link-target' | 'invalid-link-path'; href: string };

export function isOkfBundleIndex(page: PageMeta, path: string | null): boolean {
  if (!path || basename(path).toLowerCase() !== 'index.md') return false;
  const version = page.extra.okf_version;
  return version === 0.2 || version === '0.2';
}

// Each marked index starts a bundle; a nested marker takes precedence for its descendants.
export function okfBundleRootForPath(
  state: WorkspaceState,
  path: string | null,
  pathOf: (id: PageId) => string | null,
): string | null {
  if (!path) return null;
  const target = path.toLowerCase();
  const roots = Object.values(state.pages).flatMap((page) => {
    const candidate = pathOf(page.id);
    return isOkfBundleIndex(page, candidate) ? [dirname(candidate!)] : [];
  });
  return (
    roots
      .filter((root) =>
        root === ''
          ? true
          : target === root.toLowerCase() ||
            target === `${root.toLowerCase()}/index.md` ||
            target.startsWith(`${root.toLowerCase()}/`),
      )
      .sort((a, b) => b.length - a.length)[0] ?? null
  );
}

export function isOkfPath(
  state: WorkspaceState,
  path: string | null,
  pathOf: (id: PageId) => string | null,
): boolean {
  return okfBundleRootForPath(state, path, pathOf) !== null;
}

export function diagnoseOkfPage(
  page: PageMeta,
  path: string | null,
  state: WorkspaceState,
  doc: DocNode | undefined,
  pathOf: (id: PageId) => string | null,
): OkfDiagnostic[] {
  if (!path || page.kind === 'canvas' || !path.toLowerCase().endsWith('.md')) return [];
  if (!isOkfPath(state, path, pathOf)) return [];

  const diagnostics: OkfDiagnostic[] = [];
  const bundleRoot = okfBundleRootForPath(state, path, pathOf)!;
  const fileName = basename(path).toLowerCase();
  const reserved = fileName === 'index.md' || fileName === 'log.md';
  if (reserved && Object.hasOwn(page.extra, 'type')) diagnostics.push({ code: 'reserved-filename' });
  if (!reserved && !Object.hasOwn(page.extra, 'type')) diagnostics.push({ code: 'missing-type' });
  else if (!reserved && (typeof page.extra.type !== 'string' || !page.extra.type.trim()))
    diagnostics.push({ code: 'invalid-type' });

  if (!reserved && Object.hasOwn(page.extra, 'sources')) {
    const sources = page.extra.sources;
    if (!Array.isArray(sources)) diagnostics.push({ code: 'invalid-sources' });
    else
      for (const source of sources)
        if (!isRecord(source) || typeof source.resource !== 'string' || !source.resource.trim())
          diagnostics.push({ code: 'invalid-source-resource' });
  }

  const knownPaths = new Set(
    Object.values(state.pages)
      .map((candidate) => pathOf(candidate.id))
      .filter((candidate): candidate is string => candidate !== null)
      .map((candidate) => candidate.toLowerCase()),
  );
  const knownTitles = new Set(
    Object.values(state.pages).map((candidate) => candidate.title.trim().toLowerCase()),
  );
  const inspectHref = (href: string) => {
    if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return;
    let decoded = href;
    try {
      decoded = decodeURIComponent(href);
    } catch {
      // Keep the original path so malformed escapes receive the normal unresolved-link diagnostic.
    }
    const target = decoded.split('#')[0]!.split('?')[0]!;
    if (!target.toLowerCase().endsWith('.md')) return;
    const bundleRelative = target.replace(/^\/+/, '');
    const resolved = target.startsWith('/')
      ? bundleRoot
        ? `${bundleRoot}/${bundleRelative}`
        : bundleRelative
      : resolveRelative(dirname(path), target);
    if (
      resolved === null ||
      (bundleRoot !== '' &&
        resolved !== bundleRoot &&
        !resolved.toLowerCase().startsWith(`${bundleRoot.toLowerCase()}/`))
    )
      diagnostics.push({ code: 'invalid-link-path', href });
    else if (!knownPaths.has(resolved.toLowerCase())) diagnostics.push({ code: 'missing-link-target', href });
  };

  if (doc) {
    walk(doc, (node) => {
      if (node.type === 'pageLink') {
        const id = typeof node.attrs?.id === 'string' ? node.attrs.id : null;
        const target = typeof node.attrs?.target === 'string' ? node.attrs.target : null;
        if (id && !state.pages[id]) diagnostics.push({ code: 'missing-link-target', href: id });
        else if (!id && target) {
          if (target.toLowerCase().endsWith('.md')) inspectHref(target);
          else if (!knownTitles.has(target.trim().toLowerCase()))
            diagnostics.push({ code: 'missing-link-target', href: target });
        }
      }
      for (const mark of node.marks ?? []) {
        if (mark.type === 'link' && typeof mark.attrs?.href === 'string') inspectHref(mark.attrs.href);
      }
    });
  }

  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.code}:${'href' in diagnostic ? diagnostic.href : ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
