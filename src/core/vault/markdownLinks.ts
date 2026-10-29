import type { PageId } from '../model';
import type { ParseOptions } from '../markdown/parse';
import { parseOptions } from './load';
import type { Resolver } from './load';
import { dirname, relativePath } from './paths';
import { stripExtension } from './paths';

export type PagePathOf = (id: PageId) => string | null;

export function markdownTargetFromPaths(
  sourcePath: string | null,
  targetPath: string | null,
  originalHref: string,
): string | null {
  if (!sourcePath || !targetPath || /^[a-z][a-z0-9+.-]*:/i.test(originalHref) || originalHref.startsWith('//'))
    return null;
  return originalHref.startsWith('/') ? `/${targetPath}` : relativePath(dirname(sourcePath), targetPath);
}

export function markdownPathParseOptions(
  sourceDir: string,
  resolver: Resolver,
  resolveFile?: ParseOptions['resolveFile'],
): ParseOptions {
  const standard = parseOptions(sourceDir, resolver, resolveFile);
  return {
    ...standard,
    resolveLink: (href) => {
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) return null;
      const rawPath = href.split(/[?#]/, 1)[0]!;
      const decoded = safeDecode(rawPath);
      if (!/\.(md|canvas)$/i.test(decoded)) return null;
      if (decoded.startsWith('/')) return resolver.byPath(stripExtension(decoded));
      // parseOptions resolves and decodes relative paths itself. Passing `decoded`
      // here would decode percent escapes a second time (for example, `%2520` to
      // `%20`, then to a space) and can select a different page.
      return standard.resolveLink?.(rawPath) ?? null;
    },
  };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
