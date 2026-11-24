// what plugins add to morrow, kept apart from the plugins themselves so the palette and the slash menu can
// list them without loading anything
import type { Editor, Range } from '@tiptap/core';
import type { LucideIcon } from 'lucide-react';
import type { Action } from '../actions';
import type { NoteStyle, NoteStyleFont, NoteStyleWidth } from '../../core/noteStyle';
import type { NoteStyleFailureCode } from '../../storage/session';
import type { LegacyFormulaPresentation } from '../../core/legacyFormula';
import type { SupportedLocale } from '../i18n';
import type { PluginInlineFormulaEditAction } from './inlineFormulaApi';
import type { VaultFilePage } from '../platform/desktop';
import type {
  FileCatalogPreferenceReadResult,
  FileCatalogPreferenceWriteResult,
} from '../platform/fileCatalogPreferences';
import type {
  VaultCatalogFileAction,
  VaultCatalogFileActionResult,
} from '../platform/desktop';

export type PluginInlineColorKind = 'text' | 'bg';

/** A single Documento-owned custom-color control mounted into the existing selection color panel. */
export interface PluginInlineColorControlHost {
  readonly color: string;
  readonly label: string;
  readonly inputLabel: string;
  readonly invalidMessage: string;
  readonly disabled: boolean;
  apply(color: string): boolean;
  finish(): void;
}

export type PluginInlineColorControlMount = (
  container: HTMLElement,
  host: PluginInlineColorControlHost,
) => void | (() => void);

export interface PluginInlineColorControlEntry {
  readonly owner: string;
  readonly mount: PluginInlineColorControlMount;
  isActive(): boolean;
}

/** Localized labels shared with the host-owned page-style mount. */
export interface PluginNoteStylePanelLabels {
  readonly title: string;
  readonly trigger: string;
  readonly font: string;
  readonly fontSize: string;
  readonly lineHeight: string;
  readonly blockSpacing: string;
  readonly width: string;
  readonly previewWidth: string;
  readonly previewHeading: string;
  readonly previewBody: string;
  readonly fonts: Readonly<Record<NoteStyleFont, string>>;
  readonly widths: Readonly<Record<NoteStyleWidth, string>>;
  readonly save: string;
  readonly restore: string;
  readonly cancel: string;
  readonly saving: string;
  readonly saveFailed: string;
  readonly saveConflict: string;
  readonly saveBusy: string;
}

/** Result deliberately omits the host's stable page id and revision token. */
export type PluginNoteStylePanelResult =
  | { readonly ok: true; readonly style: NoteStyle; readonly message?: string }
  | {
      readonly ok: false;
      readonly code: NoteStyleFailureCode;
      readonly message: string;
    };

/** Narrow operations for one captured note; there is no generic metadata or vault access. */
export interface PluginNoteStylePanelHost {
  readonly initial: Readonly<NoteStyle>;
  readonly labels: PluginNoteStylePanelLabels;
  /** Optional live refresh for profile defaults; older hosts keep using the captured initial value. */
  readInitial?(): Readonly<NoteStyle>;
  subscribeInitial?(listener: () => void): () => void;
  save(style: NoteStyle): Promise<PluginNoteStylePanelResult>;
  restore(): Promise<PluginNoteStylePanelResult>;
  cancel(): void;
}

export type PluginNoteStylePanelMount = (
  container: HTMLElement,
  host: PluginNoteStylePanelHost,
) => void | (() => void);

export interface PluginNoteStylePanelEntry {
  readonly owner: 'polaris-documento';
  readonly generation: number;
  readonly mount: PluginNoteStylePanelMount;
  isActive(): boolean;
}

/** Documento-owned Appearance controls for the profile default used by future page creation. */
export type PluginNoteStyleBatchPreviewMode = 'preserve' | 'overwrite';

/** Summary-only view; note identities, revisions, and frontmatter stay in the host. */
export interface PluginNoteStyleBatchPreviewSummary {
  readonly mode: PluginNoteStyleBatchPreviewMode;
  readonly candidateCount: number;
  readonly titles: readonly string[];
  readonly preservedCount: number;
  readonly noOpCount: number;
  readonly protectedPageCount: number;
  readonly protectedFormatCount: number;
  readonly unsupportedSourceCount: number;
  readonly unsupportedContainerCount: number;
}

/** Opaque lease for a read-only snapshot. It cannot be used to write pages. */
export interface PluginNoteStyleBatchPreviewLease {
  readonly summary: PluginNoteStyleBatchPreviewSummary;
  isCurrent(): boolean;
  subscribe(listener: () => void): () => void;
}

/** Narrow, Documento-only preview operation for the saved default style. */
export interface PluginNoteStyleBatchPreviewHost {
  create(mode: PluginNoteStyleBatchPreviewMode): PluginNoteStyleBatchPreviewLease | null;
  invalidate(): void;
}

export interface PluginNoteStyleBatchPreviewLabels {
  readonly title: string;
  readonly help: string;
  readonly mode: string;
  readonly preserve: string;
  readonly overwrite: string;
  readonly preview: string;
  readonly cleared: string;
  readonly stale: string;
  readonly unavailable: string;
  readonly candidateCount: string;
  readonly titles: string;
  readonly preservedCount: string;
  readonly noOpCount: string;
  readonly protectedPageCount: string;
  readonly protectedFormatCount: string;
  readonly unsupportedSourceCount: string;
  readonly unsupportedContainerCount: string;
  readonly noCandidates: string;
}

export type PluginNoteStyleBatchConfirmationStatus = 'confirmed' | 'refused' | 'unattempted';

export interface PluginNoteStyleBatchConfirmationOutcome {
  readonly title: string;
  readonly order: number;
  readonly status: PluginNoteStyleBatchConfirmationStatus;
}

/** Result summary contains display titles and order only; page identities remain host-private. */
export interface PluginNoteStyleBatchConfirmationResult {
  readonly mode: PluginNoteStyleBatchPreviewMode;
  readonly outcomes: readonly PluginNoteStyleBatchConfirmationOutcome[];
  readonly confirmedCount: number;
  readonly refusedCount: number;
  readonly unattemptedCount: number;
}

export interface PluginNoteStyleBatchPreviewConfirmationLabels {
  readonly beginApply: string;
  readonly confirmPreserve: string;
  readonly confirmOverwrite: string;
  readonly confirm: string;
  readonly cancel: string;
  readonly applying: string;
  readonly applyFailed: string;
  readonly resultTitle: string;
  readonly confirmedCount: string;
  readonly refusedCount: string;
  readonly unattemptedCount: string;
  readonly noteConfirmed: string;
  readonly noteRefused: string;
  readonly noteUnattempted: string;
  readonly complete: string;
  readonly partial: string;
}

/** Optional, mount-scoped confirmation capability added after the read-only preview API. */
export interface PluginNoteStyleBatchPreviewConfirmation {
  readonly labels: PluginNoteStyleBatchPreviewConfirmationLabels;
  confirm(
    lease: PluginNoteStyleBatchPreviewLease,
  ): Promise<PluginNoteStyleBatchConfirmationResult | null>;
}

export interface PluginNoteStyleDefaultsPanelHost extends PluginNoteStylePanelHost {
  readonly batchPreview: PluginNoteStyleBatchPreviewHost;
  readonly batchPreviewLabels: PluginNoteStyleBatchPreviewLabels;
  readonly batchPreviewConfirmation?: PluginNoteStyleBatchPreviewConfirmation;
}

export interface PluginNoteStyleDefaultsPanelMount {
  (container: HTMLElement, host: PluginNoteStyleDefaultsPanelHost): void | (() => void);
  /** True when only the defaults subpanel responds to readInitial/subscribeInitial updates. */
  readonly supportsLiveProfileDefaults?: true;
}

export interface PluginNoteStyleDefaultsPanelEntry {
  readonly owner: 'polaris-documento';
  readonly generation: number;
  readonly mount: PluginNoteStyleDefaultsPanelMount;
  readonly supportsLiveProfileDefaults?: true;
  isActive(): boolean;
}

/** Minimal, read-only view of an unbound legacy result; never includes identity or raw Markdown. */
export interface PluginInlineFormulaPresentationContext extends LegacyFormulaPresentation {
  readonly locale: SupportedLocale;
  /** Invokes one host-captured edit action; the target identity stays in the host. */
  readonly onEdit?: () => void;
}

export type PluginInlineFormulaPresentationMount = (
  container: HTMLElement,
  context: PluginInlineFormulaPresentationContext,
) => void | (() => void);

export interface PluginInlineFormulaPresentationEntry {
  readonly owner: 'polaris-dados';
  readonly generation: number;
  readonly mount: PluginInlineFormulaPresentationMount;
  readonly onEdit?: PluginInlineFormulaEditAction;
  isActive(): boolean;
}

/** Read-only vault listing with profile-only filters scoped to the active Polaris Arquivos registration. */
export interface PluginSidebarFileCatalogHost {
  readonly isActive: () => boolean;
  readonly listFilesPage?: (
    directory: string,
    cursor?: string | null,
    limit?: number,
  ) => Promise<VaultFilePage>;
  readonly actOnFile?: (
    path: string,
    generation: number,
    action: VaultCatalogFileAction,
  ) => Promise<VaultCatalogFileActionResult>;
  readonly readPreferences?: () => FileCatalogPreferenceReadResult;
  readonly writePreferences?: (value: unknown | null) => FileCatalogPreferenceWriteResult;
}

export type PluginSidebarFileCatalogMount = (
  container: HTMLElement,
  host: PluginSidebarFileCatalogHost,
) => void | (() => void);

export interface PluginSidebarFileCatalogEntry {
  readonly owner: 'polaris-arquivos';
  readonly generation: number;
  readonly mount: PluginSidebarFileCatalogMount;
  readonly host: PluginSidebarFileCatalogHost;
  isActive(): boolean;
}

interface PluginNoteStylePanelRegistration extends PluginNoteStylePanelEntry {
  deactivate(): void;
}

interface PluginNoteStyleDefaultsPanelRegistration extends PluginNoteStyleDefaultsPanelEntry {
  deactivate(): void;
}

interface PluginInlineFormulaPresentationRegistration extends PluginInlineFormulaPresentationEntry {
  deactivate(): void;
}

interface PluginInlineColorControlRegistration extends PluginInlineColorControlEntry {
  deactivate(): void;
}

interface PluginSidebarFileCatalogRegistration extends PluginSidebarFileCatalogEntry {
  deactivate(): void;
}

export interface PluginBlock {
  id: string;
  title: string;
  description?: string;
  icon?: LucideIcon;
  keywords: string;
  run: (editor: Editor, range: Range) => void;
}

const actions = new Map<string, { owner: string; action: Action }>();
const blocks = new Map<string, { owner: string; block: PluginBlock }>();
const inlineColorControls = new Map<string, PluginInlineColorControlRegistration>();
let noteStylePanel: PluginNoteStylePanelRegistration | null = null;
let noteStylePanelGeneration = 0;
let noteStyleDefaultsPanel: PluginNoteStyleDefaultsPanelRegistration | null = null;
let noteStyleDefaultsPanelGeneration = 0;
let inlineFormulaPresentation: PluginInlineFormulaPresentationRegistration | null = null;
let inlineFormulaPresentationGeneration = 0;
let sidebarFileCatalog: PluginSidebarFileCatalogRegistration | null = null;
let sidebarFileCatalogGeneration = 0;
const inlineFormulaListeners = new Set<() => void>();
const listeners = new Set<() => void>();
let version = 0;

const changed = () => {
  version++;
  for (const listener of listeners) listener();
};

export function pluginActions(): Action[] {
  return [...actions.values()].map((entry) => entry.action);
}

export function pluginBlocks(): PluginBlock[] {
  return [...blocks.values()].map((entry) => entry.block);
}

export function addPluginAction(owner: string, action: Action): () => void {
  actions.set(action.id, { owner, action });
  changed();
  return () => {
    if (actions.get(action.id)?.owner === owner) actions.delete(action.id);
    changed();
  };
}

export function addPluginBlock(owner: string, block: PluginBlock): () => void {
  blocks.set(block.id, { owner, block });
  changed();
  return () => {
    if (blocks.get(block.id)?.owner === owner) blocks.delete(block.id);
    changed();
  };
}

export function addPluginInlineColorControl(owner: string, mount: PluginInlineColorControlMount): () => void {
  const previous = inlineColorControls.get(owner);
  if (previous) {
    inlineColorControls.delete(owner);
    previous.deactivate();
  }

  let active = true;
  const registration: PluginInlineColorControlRegistration = {
    owner,
    mount,
    isActive: () => active,
    deactivate: () => {
      active = false;
    },
  };
  inlineColorControls.set(owner, registration);
  changed();

  return () => {
    if (!registration.isActive()) return;
    registration.deactivate();
    if (inlineColorControls.get(owner) === registration) inlineColorControls.delete(owner);
    changed();
  };
}

export function documentoInlineColorControl(): PluginInlineColorControlEntry | null {
  return inlineColorControls.get('polaris-documento') ?? null;
}

export function addPluginNoteStylePanel(owner: string, mount: PluginNoteStylePanelMount): () => void {
  if (owner !== 'polaris-documento') throw new Error('Only Polaris Documento can add a note-style panel.');
  if (typeof mount !== 'function') throw new Error('A note-style panel needs a mount function.');

  noteStylePanel?.deactivate();
  let active = true;
  const registration: PluginNoteStylePanelRegistration = {
    owner,
    generation: ++noteStylePanelGeneration,
    mount,
    isActive: () => active,
    deactivate: () => {
      active = false;
    },
  };
  noteStylePanel = registration;
  changed();

  return () => {
    if (!registration.isActive()) return;
    registration.deactivate();
    if (noteStylePanel === registration) noteStylePanel = null;
    changed();
  };
}

export function documentoNoteStylePanel(): PluginNoteStylePanelEntry | null {
  return noteStylePanel?.isActive() ? noteStylePanel : null;
}

export function addPluginNoteStyleDefaultsPanel(
  owner: string,
  mount: PluginNoteStyleDefaultsPanelMount,
): () => void {
  if (owner !== 'polaris-documento')
    throw new Error('Only Polaris Documento can add note-style defaults to Appearance.');
  if (typeof mount !== 'function') throw new Error('A note-style defaults panel needs a mount function.');

  noteStyleDefaultsPanel?.deactivate();
  let active = true;
  const registration: PluginNoteStyleDefaultsPanelRegistration = {
    owner,
    generation: ++noteStyleDefaultsPanelGeneration,
    mount,
    ...(mount.supportsLiveProfileDefaults ? { supportsLiveProfileDefaults: true as const } : {}),
    isActive: () => active,
    deactivate: () => {
      active = false;
    },
  };
  noteStyleDefaultsPanel = registration;
  changed();

  return () => {
    if (!registration.isActive()) return;
    registration.deactivate();
    if (noteStyleDefaultsPanel === registration) noteStyleDefaultsPanel = null;
    changed();
  };
}

export function documentoNoteStyleDefaultsPanel(): PluginNoteStyleDefaultsPanelEntry | null {
  return noteStyleDefaultsPanel?.isActive() ? noteStyleDefaultsPanel : null;
}

export function addPluginInlineFormulaPresentation(
  owner: string,
  mount: PluginInlineFormulaPresentationMount,
  onEdit?: PluginInlineFormulaEditAction,
): () => void {
  if (owner !== 'polaris-dados') throw new Error('Only Polaris Dados can present inline formula results.');
  if (typeof mount !== 'function') throw new Error('An inline formula presentation needs a mount function.');
  if (onEdit !== undefined && typeof onEdit !== 'function') throw new Error('An inline formula edit action needs a handler.');

  inlineFormulaPresentation?.deactivate();
  let active = true;
  const registration: PluginInlineFormulaPresentationRegistration = {
    owner,
    generation: ++inlineFormulaPresentationGeneration,
    mount,
    ...(onEdit ? { onEdit } : {}),
    isActive: () => active,
    deactivate: () => { active = false; },
  };
  inlineFormulaPresentation = registration;
  notifyInlineFormulaPresentation();

  return () => {
    if (!registration.isActive()) return;
    registration.deactivate();
    if (inlineFormulaPresentation === registration) inlineFormulaPresentation = null;
    notifyInlineFormulaPresentation();
  };
}

export function polarisDadosInlineFormulaPresentation(): PluginInlineFormulaPresentationEntry | null {
  return inlineFormulaPresentation?.isActive() ? inlineFormulaPresentation : null;
}

export function addPluginSidebarFileCatalog(
  owner: string,
  generation: number,
  mount: PluginSidebarFileCatalogMount,
  host: PluginSidebarFileCatalogHost,
  ownerIsActive: () => boolean,
): () => void {
  if (owner !== 'polaris-arquivos') throw new Error('Only Polaris Arquivos can add a sidebar file catalog.');
  if (typeof mount !== 'function') throw new Error('A sidebar file catalog needs a mount function.');
  if (!host || typeof host.isActive !== 'function') throw new Error('A sidebar file catalog needs an active host.');
  if (typeof ownerIsActive !== 'function') throw new Error('A sidebar file catalog needs an owner guard.');

  sidebarFileCatalog?.deactivate();
  let active = true;
  sidebarFileCatalogGeneration = Math.max(sidebarFileCatalogGeneration + 1, generation);
  let registration: PluginSidebarFileCatalogRegistration | null = null;
  const registrationIsActive = () =>
    active && registration !== null && sidebarFileCatalog === registration && ownerIsActive() && host.isActive();
  const stalePage = (currentGeneration = 0): VaultFilePage => ({
    generation: currentGeneration,
    status: 'stale',
    entries: [],
    nextCursor: null,
    error: null,
  });
  const listFilesPage = host.listFilesPage;
  const actOnFile = host.actOnFile;
  const readPreferences = host.readPreferences;
  const writePreferences = host.writePreferences;
  const guardedHost: PluginSidebarFileCatalogHost = Object.freeze({
    isActive: registrationIsActive,
    ...(typeof listFilesPage === 'function'
      ? {
          async listFilesPage(directory: string, cursor?: string | null, limit?: number): Promise<VaultFilePage> {
            if (!registrationIsActive()) return stalePage();
            try {
              const page = await listFilesPage(directory, cursor, limit);
              return registrationIsActive() ? page : stalePage(page.generation);
            } catch (error) {
              if (!registrationIsActive()) return stalePage();
              throw error;
            }
          },
        }
      : {}),
    ...(typeof actOnFile === 'function'
      ? {
          async actOnFile(
            path: string,
            generation: number,
            action: VaultCatalogFileAction,
          ): Promise<VaultCatalogFileActionResult> {
            if (!registrationIsActive()) return { generation, status: 'stale' };
            try {
              const result = await actOnFile(path, generation, action);
              return registrationIsActive() ? result : { generation: result.generation, status: 'stale' };
            } catch {
              return registrationIsActive()
                ? { generation, status: 'failed' }
                : { generation, status: 'stale' };
            }
          },
        }
      : {}),
    ...(typeof readPreferences === 'function'
      ? {
          readPreferences(): FileCatalogPreferenceReadResult {
            if (!registrationIsActive()) return { status: 'unavailable' };
            try {
              const result = readPreferences();
              return registrationIsActive() ? result : { status: 'unavailable' };
            } catch {
              return { status: 'unavailable' };
            }
          },
        }
      : {}),
    ...(typeof writePreferences === 'function'
      ? {
          writePreferences(value: unknown | null): FileCatalogPreferenceWriteResult {
            if (!registrationIsActive()) return { status: 'unavailable' };
            try {
              const result = writePreferences(value);
              return registrationIsActive() ? result : { status: 'unavailable' };
            } catch {
              return { status: 'unavailable' };
            }
          },
        }
      : {}),
  });
  registration = {
    owner: 'polaris-arquivos',
    generation: sidebarFileCatalogGeneration,
    mount,
    host: guardedHost,
    isActive: registrationIsActive,
    deactivate: () => {
      active = false;
    },
  };
  sidebarFileCatalog = registration;
  changed();

  return () => {
    if (!registration.isActive()) {
      // A replaced registration is already inactive and cannot remove its successor.
      if (sidebarFileCatalog !== registration) return;
      registration.deactivate();
    } else {
      registration.deactivate();
    }
    if (sidebarFileCatalog === registration) sidebarFileCatalog = null;
    changed();
  };
}

export function polarisArquivosSidebarFileCatalog(): PluginSidebarFileCatalogEntry | null {
  return sidebarFileCatalog?.isActive() ? sidebarFileCatalog : null;
}

export function subscribeInlineFormulaPresentation(listener: () => void): () => void {
  inlineFormulaListeners.add(listener);
  return () => inlineFormulaListeners.delete(listener);
}

function notifyInlineFormulaPresentation(): void {
  for (const listener of inlineFormulaListeners) {
    try {
      listener();
    } catch {
      // One renderer cannot block teardown or updates for other inline results.
    }
  }
}

export function subscribePlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pluginsVersion(): number {
  return version;
}
