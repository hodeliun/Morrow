// what plugins add to morrow, kept apart from the plugins themselves so the palette and the slash menu can
// list them without loading anything
import type { Editor, Range } from '@tiptap/core';
import type { LucideIcon } from 'lucide-react';
import type { Action } from '../actions';
import type { NoteStyle, NoteStyleFont, NoteStyleWidth } from '../../core/noteStyle';
import type { NoteStyleFailureCode } from '../../storage/session';

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
  | { readonly ok: true; readonly style: NoteStyle }
  | {
      readonly ok: false;
      readonly code: NoteStyleFailureCode;
      readonly message: string;
    };

/** Narrow operations for one captured note; there is no generic metadata or vault access. */
export interface PluginNoteStylePanelHost {
  readonly initial: Readonly<NoteStyle>;
  readonly labels: PluginNoteStylePanelLabels;
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

interface PluginNoteStylePanelRegistration extends PluginNoteStylePanelEntry {
  deactivate(): void;
}

interface PluginInlineColorControlRegistration extends PluginInlineColorControlEntry {
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

export function subscribePlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pluginsVersion(): number {
  return version;
}
