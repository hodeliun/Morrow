import type { ResultFailure } from '../core/result';
import { tp, t } from './i18n';
import type { SupportedLocale } from './i18n';

export function commandErrorMessage(
  failure: ResultFailure,
  titleForPage: (pageId: string) => string | undefined,
  locale: SupportedLocale,
): string {
  const reason = failure.reason;
  if (reason?.kind !== 'linkedViewsBlockingTrash') return failure.error;

  const pageNames = [...new Set(reason.hostPageIds)]
    .map(titleForPage)
    .filter((title): title is string => title !== undefined)
    .slice(0, 3);
  if (!pageNames.length) return failure.error;

  const quotedNames = pageNames.map((name) => `“${name}”`);
  const pages = new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(quotedNames);
  const additionalCount = Math.max(reason.referenceCount - pageNames.length, 0);
  const additional = additionalCount
    ? ` ${tp('database.linkedSourceInUseMoreReferences', additionalCount, undefined, locale)}`
    : '';

  return `${t('database.linkedSourceInUsePages', { pages }, locale)}${additional} ${t(
    'database.linkedSourceInUseInstruction',
    undefined,
    locale,
  )}`;
}
