// what plugins add to morrow, kept apart from the plugins themselves so the palette and the slash menu can
// list them without loading anything
import type { Editor, Range } from '@tiptap/core';
import type { LucideIcon } from 'lucide-react';
import type { Action } from '../actions';

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

export function subscribePlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function pluginsVersion(): number {
  return version;
}
