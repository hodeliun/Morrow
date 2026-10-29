import { useSyncExternalStore } from 'react';
import type { Command } from '../core/commands';
import { displayTitle } from '../core/model';
import type { WorkspaceState } from '../core/model';
import type { Result } from '../core/result';
import type { FileCatalogSnapshot } from '../core/vault/fileCatalog';
import type { SaveStatus } from '../storage/saveQueue';
import type { WorkspaceSession } from '../storage/session';
import { commandErrorMessage } from './commandMessages';
import { getLocale } from './i18n';
import { toast } from './ui';
import { getPreferences, legacyNoteStyle } from './platform/preferences';

let session: WorkspaceSession | null = null;

export function setSession(next: WorkspaceSession): void {
  session = next;
}

export function getSession(): WorkspaceSession {
  if (!session) throw new Error('Workspace is not open yet.');
  return session;
}

export function getState(): WorkspaceState {
  return getSession().getState();
}

// runs a command and tells the user when it is refused
export function run(command: Command): Result<WorkspaceState> {
  const result = getSession().execute(withNoteDefaults(command));
  if (!result.ok) toast(commandErrorMessage(result, pageTitle, getLocale()), { tone: 'error' });
  return result;
}

export function runAll(commands: Command[]): Result<WorkspaceState> {
  const result = getSession().executeAll(commands.map(withNoteDefaults));
  if (!result.ok) toast(commandErrorMessage(result, pageTitle, getLocale()), { tone: 'error' });
  return result;
}

function pageTitle(id: string): string | undefined {
  const page = getState().pages[id];
  return page ? displayTitle(page) : undefined;
}

function withNoteDefaults(command: Command): Command {
  if (
    command.type !== 'page.create' ||
    command.noteStyle !== undefined ||
    command.kind === 'canvas'
  )
    return command;
  const preferences = getPreferences();
  const style = preferences.defaultNoteStyle;
  if (command.kind === 'database') return { ...command, noteStyle: { ...style, width: 'full' } };
  // the legacy appearance is now fixed for existing pages, so its matching default needs no frontmatter
  if (JSON.stringify(style) === JSON.stringify(legacyNoteStyle(preferences.font, preferences.width)))
    return command;
  return { ...command, noteStyle: style };
}

export function useWorkspace(): WorkspaceState {
  const current = getSession();
  return useSyncExternalStore(current.subscribe, current.getState, current.getState);
}

export function useFileCatalog(): FileCatalogSnapshot {
  const current = getSession();
  return useSyncExternalStore(
    current.subscribeFileCatalog,
    current.getFileCatalog,
    current.getFileCatalog,
  );
}

export function useSaveStatus(): SaveStatus {
  const queue = getSession().queue;
  return useSyncExternalStore(
    (listener) => queue.subscribe(listener),
    () => queue.status,
  );
}
