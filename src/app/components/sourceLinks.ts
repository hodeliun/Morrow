import { docToMarkdown } from '../../core/markdown/serialize';
import type { SerializeOptions } from '../../core/markdown/serialize';
import { displayTitle } from '../../core/model';
import type { DocNode, FileMeta, PageId, WorkspaceState } from '../../core/model';
import { makeResolver, resolveFile } from '../../core/vault/load';
import type { ParseOptions } from '../../core/markdown/parse';
import type { Placement } from '../../core/vault/layout';
import { markdownPathParseOptions, markdownTargetFromPaths } from '../../core/vault/markdownLinks';
import { basename, dirname, relativePath, stripExtension } from '../../core/vault/paths';
import { resolveLinkTarget } from '../../core/search';
import type { PagePathOf } from '../../core/vault/markdownLinks';

export function sourceMarkdown(
  doc: DocNode,
  state: WorkspaceState,
  pageId: PageId,
  pathOf: PagePathOf,
): string {
  return docToMarkdown(doc, sourceMarkdownSerializeOptions(state, pageId, pathOf));
}

export function sourceMarkdownParseOptions(
  state: WorkspaceState,
  pageId: PageId,
  pathOf: PagePathOf,
  resolveFile?: ParseOptions['resolveFile'],
): ParseOptions {
  const fallback: ParseOptions = {
    resolvePage: (target) => resolveLinkTarget(state, target),
    resolveLink: (href) => resolveLinkTarget(state, href),
    ...(resolveFile ? { resolveFile } : {}),
  };
  const sourcePath = pathOf(pageId);
  if (!sourcePath) return fallback;

  const layout = new Map<PageId, Placement>();
  for (const page of Object.values(state.pages)) {
    const pagePath = pathOf(page.id);
    if (!pagePath) continue;
    const extension = /\.(?:md|canvas)$/i.exec(pagePath)?.[0] ?? null;
    layout.set(page.id, {
      file: extension ? pagePath : null,
      folder: extension ? stripExtension(pagePath) : pagePath,
    });
  }
  const resolver = makeResolver(state, layout, new Map());
  return markdownPathParseOptions(dirname(sourcePath), resolver, resolveFile);
}

export function sourceMarkdownSerializeOptions(
  state: WorkspaceState,
  pageId: PageId,
  pathOf: PagePathOf,
): SerializeOptions {
  const sourcePath = pathOf(pageId);
  return {
    titleOf: (id) => (state.pages[id] ? displayTitle(state.pages[id]!) : null),
    filePath: (fileId, originalHref) => {
      if (!fileId || originalHref?.startsWith('#') || originalHref?.startsWith('//')) return null;
      if (originalHref && /^[a-z][a-z0-9+.-]*:/i.test(originalHref)) return null;
      if (!sourcePath) return fileId; // Preserve the existing pathless IndexedDB representation.
      return originalHref?.startsWith('/')
        ? `/${fileId.replace(/^\/+/, '')}`
        : relativePath(dirname(sourcePath), fileId);
    },
    markdownLinkTarget: (id, originalHref) =>
      markdownTargetFromPaths(sourcePath, pathOf(id), originalHref),
  };
}

export function sourceFileResolver(
  files: FileMeta[],
  sourceDir?: string | null,
): NonNullable<ParseOptions['resolveFile']> {
  const byId = new Map(files.map((file) => [file.id, file]));
  const byName = new Map<string, FileMeta[]>();
  const index = new Map<string, string>();
  for (const file of files) {
    const path = file.id.replace(/\\/g, '/');
    index.set(path.toLowerCase(), path);
    const name = basename(file.name || path).toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), file]);
  }
  const names = new Map(
    [...byName]
      .filter(([, matches]) => matches.length === 1)
      .map(([name, matches]) => [name, [matches[0]!.id]]),
  );

  return (href) => {
    if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;

    if (sourceDir !== null && sourceDir !== undefined) return resolveFile(sourceDir, href, index, names);

    // A pathless IndexedDB session can resolve exact IDs and unique names only.
    const rawPath = href.split(/[?#]/, 1)[0]!;
    if (!rawPath) return null;
    let clean = rawPath;
    try {
      clean = decodeURIComponent(rawPath);
    } catch {
      // Keep malformed escapes literal, matching the vault resolver.
    }
    if (clean.split('/').includes('..')) return null;
    clean = clean.replace(/^\/+/, '').replace(/^(\.\/)+/, '');
    const exact = byId.get(clean);
    if (exact) return { fileId: exact.id, name: exact.name, image: exact.type.startsWith('image/') };
    if (clean.includes('/')) return null;
    const matches = byName.get(clean.toLowerCase()) ?? [];
    if (matches.length !== 1) return null;
    const file = matches[0]!;
    return { fileId: file.id, name: file.name, image: file.type.startsWith('image/') };
  };
}
