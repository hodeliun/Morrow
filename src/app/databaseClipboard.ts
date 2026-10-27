import type { PageId } from '../core/model';
import { copyText } from './platform/desktop';
import { t } from './i18n';
import { toast } from './ui';
import { getSession, getState } from './workspace';

let copied: { sourceId: PageId; marker: string; session: ReturnType<typeof getSession> } | null = null;

export async function copyDatabase(sourceId: PageId): Promise<void> {
  const source = getState().pages[sourceId];
  if (!source?.database) return;
  const marker = `morrow://database-copy/${sourceId}/${crypto.randomUUID()}`;
  if (!(await copyText(marker))) {
    toast(t('database.copyFailed'), { tone: 'error' });
    return;
  }
  copied = { sourceId, marker, session: getSession() };
  toast(t('database.copyReady'));
}

export function copiedDatabaseId(text: string): PageId | null {
  return copied && copied.session === getSession() && text === copied.marker && getState().pages[copied.sourceId]?.database
    ? copied.sourceId
    : null;
}
