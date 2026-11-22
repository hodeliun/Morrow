import type { Editor, Range } from '@tiptap/core';
import { exitSuggestion } from '@tiptap/suggestion';
import {
  createLegacyFormulaMarker,
  LEGACY_FORMULA_NODE,
  legacyFormulaDocIssue,
  parseLegacyFormulaMarker,
} from '../../core/legacyFormula';
import type { LegacyFormulaMarkerInput } from '../../core/legacyFormula';
import { newId } from '../platform/files';
import { captureEditorInsertionTarget } from '../editor/editorInsertion';
import type { EditorInsertionOwner } from '../editor/editorInsertion';
import { pageEditorInsertionPeerFor } from '../editor/pageEditorCoordination';
import { SLASH_COMMAND_PLUGIN_KEY } from '../editor/SlashCommand';
import { activeHash, getTabs, targetPane } from '../tabs';
import { parseRoute } from '../router';
import type { PluginEditorInsertionTargetV1 } from './editorApi';
import { addPluginBlock } from './registry';
import type { PluginBlock } from './registry';
import { getWorkspaceSessionGeneration } from '../workspace';
import type {
  PluginInlineFormulaConfirmation,
  PluginInlineFormulaInsertionHost,
  PluginInlineFormulaInsertionResult,
  PluginInlineFormulaSlashCommand,
} from './inlineFormulaApi';

const fail = (
  reason: Extract<PluginInlineFormulaInsertionResult, { ok: false }>['reason'],
): PluginInlineFormulaInsertionResult => ({
  ok: false,
  reason,
});

/** Registers the one Dados-only slash entry and revokes every pending operation on cleanup. */
export function addInlineFormulaSlashCommand(
  owner: EditorInsertionOwner,
  bindTarget: (target: PluginEditorInsertionTargetV1) => PluginEditorInsertionTargetV1,
  command: PluginInlineFormulaSlashCommand,
): () => void {
  if (typeof command?.onInvoke !== 'function')
    throw new Error('A formula slash command needs an onInvoke handler.');
  const title = typeof command.title === 'string' ? command.title.slice(0, 100) : '';
  if (!title) throw new Error('A formula slash command needs a title.');

  const generation = owner.generation;
  const pending = new Set<PluginInlineFormulaInsertionHost>();
  let active = true;
  const block: PluginBlock = {
    id: `plugin:polaris-dados:inline-formula-${generation}`,
    title,
    ...(typeof command.description === 'string' ? { description: command.description.slice(0, 300) } : {}),
    keywords: `${typeof command.keywords === 'string' ? command.keywords.slice(0, 300) : ''} formula result inline`,
    run: (editor, range) => {
      if (!active || !ownerIsActive(owner, generation)) return;
      if (!safeSlashRange(editor, range)) return;
      const peer = pageEditorInsertionPeerFor(editor);
      if (!peer) return;
      const navigation = formulaNavigationSnapshot();
      if (!navigation || navigation.pane !== peer.pane || navigation.pageId !== peer.pageId) return;
      const sessionGeneration = getWorkspaceSessionGeneration();

      const rawTarget = captureEditorInsertionTarget(owner, { editor, range, inlineRange: true });
      if (!rawTarget) return;
      let target: PluginEditorInsertionTargetV1;
      try {
        target = bindTarget(rawTarget);
      } catch {
        rawTarget.dispose();
        return;
      }

      let consumed = false;
      const close = () => {
        if (consumed) return;
        consumed = true;
        target.dispose();
        pending.delete(host);
      };
      const host: PluginInlineFormulaInsertionHost = Object.freeze({
        dismiss() {
          if (consumed || !active || !ownerIsActive(owner, generation) || editor.isDestroyed) return;
          try {
            exitSuggestion(editor.view, SLASH_COMMAND_PLUGIN_KEY);
          } catch {
            // Dismissing the suggestion is best-effort; the captured target remains independently guarded.
          }
        },
        canRestoreFocus() {
          if (!ownerIsActive(owner, generation) || editor.isDestroyed || !editor.view.dom.isConnected)
            return false;
          if (getWorkspaceSessionGeneration() !== sessionGeneration || peer.session.isClosed) return false;
          const currentPeer = pageEditorInsertionPeerFor(editor);
          if (!currentPeer || currentPeer.identity !== peer.identity || currentPeer.session !== peer.session || currentPeer.pane !== peer.pane)
            return false;
          const currentNavigation = formulaNavigationSnapshot();
          return Boolean(currentNavigation && sameFormulaNavigation(navigation, currentNavigation));
        },
        confirm(input: PluginInlineFormulaConfirmation): PluginInlineFormulaInsertionResult {
          if (consumed) return fail('already-used');
          if (!active || !ownerIsActive(owner, generation)) {
            close();
            return fail('owner-ended');
          }
          const validated = validateConfirmation(input);
          if (!validated) return fail('invalid-input');

          const resultId = uniqueResultId(editor);
          if (!resultId) {
            close();
            return fail('invalid-input');
          }
          const markerInput: LegacyFormulaMarkerInput = {
            resultId,
            pageId: peer.pageId,
            formula: validated.formula,
            ...(validated.name !== undefined ? { name: validated.name } : {}),
          };
          const marker = createLegacyFormulaMarker(markerInput);
          if (!marker || !candidateIsRepresentable(editor, range, marker)) {
            close();
            return fail('unsupported-target');
          }

          const result = target.insert(marker.raw);
          consumed = true;
          pending.delete(host);
          return result;
        },
        cancel() {
          close();
        },
      });
      pending.add(host);
      try {
        command.onInvoke(host);
      } catch {
        host.cancel();
      }
    },
  };
  const unregister = addPluginBlock('polaris-dados', block);

  return () => {
    if (!active) return;
    active = false;
    for (const host of [...pending]) host.cancel();
    unregister();
  };
}

function ownerIsActive(owner: EditorInsertionOwner, generation: number): boolean {
  try {
    return owner.generation === generation && owner.isActive();
  } catch {
    return false;
  }
}

interface FormulaNavigationSnapshot {
  readonly activeTab: string;
  readonly pane: string;
  readonly hash: string;
  readonly pageId: string;
}

function formulaNavigationSnapshot(): FormulaNavigationSnapshot | null {
  try {
    const tabs = getTabs();
    const tab = tabs.tabs.find((item) => item.id === tabs.active);
    const pane = targetPane();
    const hash = activeHash();
    const route = parseRoute(hash);
    if (!tab || route.name !== 'page') return null;
    return { activeTab: tab.id, pane, hash, pageId: route.id };
  } catch {
    return null;
  }
}

function sameFormulaNavigation(first: FormulaNavigationSnapshot, second: FormulaNavigationSnapshot): boolean {
  return first.activeTab === second.activeTab && first.pane === second.pane &&
    first.hash === second.hash && first.pageId === second.pageId;
}

function safeSlashRange(editor: Editor, range: Range): boolean {
  try {
    const { doc, selection } = editor.state;
    if (
      editor.isDestroyed ||
      !editor.view.dom.isConnected ||
      !selection.empty ||
      selection.from !== range.to ||
      range.from < 0 ||
      range.to <= range.from ||
      range.to > doc.content.size
    )
      return false;

    const from = doc.resolve(range.from);
    const to = doc.resolve(range.to);
    if (
      from.depth !== 1 ||
      to.depth !== 1 ||
      from.parent !== to.parent ||
      from.parent.type.name !== 'paragraph'
    )
      return false;

    const text = doc.textBetween(range.from, range.to, '\n', '\uFFFC');
    if (!text.startsWith('/') || text.length > 41 || /[\r\n\uFFFC]/.test(text)) return false;

    let atomFound = false;
    doc.nodesBetween(range.from, range.to, (node) => {
      if (node.isAtom && !node.isText) atomFound = true;
    });
    return !atomFound;
  } catch {
    return false;
  }
}

function validateConfirmation(input: unknown): PluginInlineFormulaConfirmation | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'formula' && key !== 'name')) return null;
  if (typeof value.formula !== 'string' || value.formula.length > 2000) return null;
  if (value.name !== undefined && (typeof value.name !== 'string' || value.name.length > 100)) return null;
  return {
    formula: value.formula,
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
  };
}

function uniqueResultId(editor: Editor): string | null {
  const existing = new Set<string>();
  editor.state.doc.descendants((node) => {
    if (node.type.name !== LEGACY_FORMULA_NODE || typeof node.attrs.raw !== 'string') return;
    const marker = parseLegacyFormulaMarker(node.attrs.raw);
    if (marker) existing.add(marker.resultId);
  });

  for (let attempt = 0; attempt < 8; attempt++) {
    const id = newId();
    if (/^[A-Za-z0-9_-]{1,64}$/.test(id) && !existing.has(id)) return id;
  }
  return null;
}

function candidateIsRepresentable(
  editor: Editor,
  range: Range,
  marker: { raw: string; fallback: string },
): boolean {
  try {
    const nodeType = editor.schema.nodes[LEGACY_FORMULA_NODE];
    if (!nodeType) return false;
    const marks = editor.state.storedMarks ?? editor.state.doc.resolve(range.from).marks();
    const node = nodeType.create({ raw: marker.raw, fallback: marker.fallback }, null, marks);
    const candidate = editor.state.tr.replaceWith(range.from, range.to, node).doc;
    return legacyFormulaDocIssue(candidate.toJSON()) === null;
  } catch {
    return false;
  }
}
