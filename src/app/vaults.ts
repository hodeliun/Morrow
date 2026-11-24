import type { ExitPreparationLease, ExitPreparationSession } from './exitPreparation';
import { getExitPreparer } from './exitPreparationRegistry';
import { COPY_LEGACY_KEY } from './legacy';
import { desktop } from './platform/desktop';
import { t } from './i18n';
import { toast } from './ui';

interface CopyLegacyChange {
  readonly previous: string | null;
  readonly written: string | null;
}

function restoreCopyLegacyIntent(change: CopyLegacyChange | null): void {
  if (!change) return;
  try {
    if (sessionStorage.getItem(COPY_LEGACY_KEY) !== change.written) return;
    if (change.previous === null) sessionStorage.removeItem(COPY_LEGACY_KEY);
    else sessionStorage.setItem(COPY_LEGACY_KEY, change.previous);
  } catch {
    // Storage can be unavailable while the reload is being rejected. Keep the save failure visible.
  }
}

// opens another folder: pending edits are saved, then the window starts over with the new vault
export async function switchVault(dir: string, options: { copyLegacy?: boolean } = {}): Promise<boolean> {
  const vault = desktop?.vault;
  if (!vault) return false;

  let lease: ExitPreparationLease<ExitPreparationSession> | null = null;
  let reloadEmitted = false;
  let copyLegacyChange: CopyLegacyChange | null = null;

  try {
    const preparer = getExitPreparer();
    if (!preparer) {
      toast(t('topBar.saveFailed'), { tone: 'error' });
      return false;
    }

    const preparation = await preparer.prepare();
    if (!preparation.ok) {
      toast(t('topBar.saveFailed'), { tone: 'error' });
      return false;
    }
    lease = preparation.lease;

    const result = await vault.select(dir);
    if (!result.ok) {
      toast(result.error ?? t('toasts.folderCouldNotOpen'), { tone: 'error' });
      return false;
    }

    const previous = sessionStorage.getItem(COPY_LEGACY_KEY);
    const written = options.copyLegacy === true ? '1' : null;
    if (previous !== written) {
      // Record the intended write first so an operation that mutates and then throws can be
      // conditionally undone without erasing a newer copy intent.
      copyLegacyChange = { previous, written };
      if (written === null) sessionStorage.removeItem(COPY_LEGACY_KEY);
      else sessionStorage.setItem(COPY_LEGACY_KEY, written);
    }

    window.location.reload();
    reloadEmitted = true;
    return true;
  } catch (error) {
    restoreCopyLegacyIntent(copyLegacyChange);
    const message = error instanceof Error ? error.message : error == null ? '' : String(error);
    toast(message || t('toasts.folderCouldNotOpen'), { tone: 'error', durationMs: 8000 });
    return false;
  } finally {
    if (lease && !reloadEmitted) lease.release();
  }
}

// asks for a folder. a phone first asks to be allowed to read files outside the app, and says so when it is not
export async function chooseFolder(): Promise<string | null> {
  try {
    return (await desktop?.vault?.choose()) ?? null;
  } catch (error) {
    toast(error instanceof Error ? error.message : String(error), { tone: 'error', durationMs: 8000 });
    return null;
  }
}

export async function chooseVaultFolder(options: { copyLegacy?: boolean } = {}): Promise<void> {
  const dir = await chooseFolder();
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
