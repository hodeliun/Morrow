import { commitEditors } from './editor/commits';
import { COPY_LEGACY_KEY } from './legacy';
import { desktop } from './platform/desktop';
import { t } from './i18n';
import { toast } from './ui';
import { getSession } from './workspace';

function isInitialWorkspaceMissing(error: unknown): boolean {
  return error instanceof Error && error.message === 'Workspace is not open yet.';
}

function showSaveFailure(error: string): void {
  toast(t('topBar.saveError', { error }), { tone: 'error' });
}

// opens another folder: pending edits are saved, then the window starts over with the new vault
export async function switchVault(dir: string, options: { copyLegacy?: boolean } = {}): Promise<boolean> {
  const vault = desktop?.vault;
  if (!vault) return false;

  let session: ReturnType<typeof getSession> | null;
  try {
    session = getSession();
  } catch (error) {
    if (!isInitialWorkspaceMissing(error)) {
      showSaveFailure(error instanceof Error ? error.message : String(error));
      return false;
    }
    session = null;
  }

  if (session) {
    try {
      commitEditors();
      if (!(await session.flush())) {
        showSaveFailure(session.queue.status.error ?? t('topBar.unknownError'));
        return false;
      }
    } catch (error) {
      showSaveFailure(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  const result = await vault.select(dir);
  if (!result.ok) {
    toast(result.error ?? t('toasts.folderCouldNotOpen'), { tone: 'error' });
    return false;
  }
  if (options.copyLegacy) sessionStorage.setItem(COPY_LEGACY_KEY, '1');
  window.location.reload();
  return true;
}

export async function chooseVaultFolder(options: { copyLegacy?: boolean } = {}): Promise<void> {
  const dir = await desktop?.vault?.choose();
  if (dir) await switchVault(dir, options);
}

export async function createVault(options: { copyLegacy?: boolean } = {}): Promise<void> {
  const vault = desktop?.vault;
  if (!vault) return;
  try {
    await switchVault(await vault.createDefault(), options);
  } catch (error) {
    toast(
      t('toasts.folderCouldNotCreate', { error: error instanceof Error ? error.message : String(error) }),
      {
        tone: 'error',
      },
    );
  }
}
