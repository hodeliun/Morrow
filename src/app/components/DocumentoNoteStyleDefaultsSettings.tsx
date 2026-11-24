import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { isValidNoteStyleInput, resolveDefaultNoteStyle } from '../../core/noteStyle';
import type { NoteStyle } from '../../core/noteStyle';
import { SettingsGroup } from './SettingsRows';
import { t } from '../i18n';
import { confirmNoteStyleBatchPreview, createNoteStyleBatchPreviewHost } from './noteStyleBatchPreview';
import { documentoNoteStyleDefaultsPanel, subscribePlugins } from '../plugins/registry';
import type {
  PluginNoteStyleDefaultsPanelHost,
  PluginNoteStyleBatchPreviewLabels,
  PluginNoteStyleBatchPreviewConfirmationLabels,
  PluginNoteStyleBatchPreviewLease,
  PluginNoteStylePanelLabels,
  PluginNoteStylePanelResult,
} from '../plugins/registry';
import { getPreferences, setPreferences, subscribePreferences, usePreferences } from '../platform/preferences';

function copyStyle(style: Readonly<NoteStyle>): NoteStyle {
  return {
    font: style.font,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    blockSpacing: style.blockSpacing,
    width: style.width,
  };
}

function labelsFor(locale: ReturnType<typeof usePreferences>['locale']): PluginNoteStylePanelLabels {
  const translate = (key: Parameters<typeof t>[0]) => t(key, undefined, locale);
  return Object.freeze({
    title: translate('pageStyle.defaultsTitle'),
    trigger: translate('pageStyle.trigger'),
    font: translate('pageStyle.font'),
    fontSize: translate('pageStyle.fontSize'),
    lineHeight: translate('pageStyle.lineHeight'),
    blockSpacing: translate('pageStyle.blockSpacing'),
    width: translate('pageStyle.width'),
    previewWidth: translate('pageStyle.previewWidth'),
    previewHeading: translate('pageStyle.previewHeading'),
    previewBody: translate('pageStyle.previewBody'),
    fonts: Object.freeze({
      serif: translate('pageStyle.fonts.serif'),
      sans: translate('pageStyle.fonts.sans'),
      mono: translate('pageStyle.fonts.mono'),
    }),
    widths: Object.freeze({
      comfortable: translate('pageStyle.widths.comfortable'),
      wide: translate('pageStyle.widths.wide'),
      full: translate('pageStyle.widths.full'),
    }),
    save: translate('pageStyle.saveDefault'),
    restore: translate('pageStyle.resetDefault'),
    cancel: translate('pageStyle.discardDefault'),
    saving: translate('pageStyle.saving'),
    saveFailed: translate('pageStyle.defaultSaveFailed'),
    saveConflict: translate('pageStyle.defaultSaveFailed'),
    saveBusy: translate('pageStyle.saveBusy'),
  });
}

export function DocumentoNoteStyleDefaultsSettings() {
  const preferences = usePreferences();
  const containerRef = useRef<HTMLDivElement>(null);
  const registration = useSyncExternalStore(
    subscribePlugins,
    documentoNoteStyleDefaultsPanel,
    documentoNoteStyleDefaultsPanel,
  );
  const labels = useMemo(() => labelsFor(preferences.locale), [preferences.locale]);
  const defaultProfileRefreshKey = registration?.supportsLiveProfileDefaults
    ? null
    : JSON.stringify([preferences.font, preferences.width]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !registration?.isActive()) return;

    const initialPreferences = getPreferences();
    const initialStyle = resolveDefaultNoteStyle(
      initialPreferences.defaultNoteStyle,
      initialPreferences.font,
      initialPreferences.width,
    );
    const mountState = { active: true };
    const translate = (key: Parameters<typeof t>[0]) => t(key, undefined, preferences.locale);
    const batchPreviewLabels: PluginNoteStyleBatchPreviewLabels = Object.freeze({
      title: translate('pageStyle.batchPreview.title'),
      help: translate('pageStyle.batchPreview.help'),
      mode: translate('pageStyle.batchPreview.mode'),
      preserve: translate('pageStyle.batchPreview.preserve'),
      overwrite: translate('pageStyle.batchPreview.overwrite'),
      preview: translate('pageStyle.batchPreview.preview'),
      cleared: translate('pageStyle.batchPreview.cleared'),
      stale: translate('pageStyle.batchPreview.stale'),
      unavailable: translate('pageStyle.batchPreview.unavailable'),
      candidateCount: translate('pageStyle.batchPreview.candidateCount'),
      titles: translate('pageStyle.batchPreview.titles'),
      preservedCount: translate('pageStyle.batchPreview.preservedCount'),
      noOpCount: translate('pageStyle.batchPreview.noOpCount'),
      protectedPageCount: translate('pageStyle.batchPreview.protectedPageCount'),
      protectedFormatCount: translate('pageStyle.batchPreview.protectedFormatCount'),
      unsupportedSourceCount: translate('pageStyle.batchPreview.unsupportedSourceCount'),
      unsupportedContainerCount: translate('pageStyle.batchPreview.unsupportedContainerCount'),
      noCandidates: translate('pageStyle.batchPreview.noCandidates'),
    });
    const confirmationLabels: PluginNoteStyleBatchPreviewConfirmationLabels = Object.freeze({
      beginApply: translate('pageStyle.batchPreview.confirmation.beginApply'),
      confirmPreserve: translate('pageStyle.batchPreview.confirmation.confirmPreserve'),
      confirmOverwrite: translate('pageStyle.batchPreview.confirmation.confirmOverwrite'),
      confirm: translate('pageStyle.batchPreview.confirmation.confirm'),
      cancel: translate('pageStyle.batchPreview.confirmation.cancel'),
      applying: translate('pageStyle.batchPreview.confirmation.applying'),
      applyFailed: translate('pageStyle.batchPreview.confirmation.applyFailed'),
      resultTitle: translate('pageStyle.batchPreview.confirmation.resultTitle'),
      confirmedCount: translate('pageStyle.batchPreview.confirmation.confirmedCount'),
      refusedCount: translate('pageStyle.batchPreview.confirmation.refusedCount'),
      unattemptedCount: translate('pageStyle.batchPreview.confirmation.unattemptedCount'),
      noteConfirmed: translate('pageStyle.batchPreview.confirmation.noteConfirmed'),
      noteRefused: translate('pageStyle.batchPreview.confirmation.noteRefused'),
      noteUnattempted: translate('pageStyle.batchPreview.confirmation.noteUnattempted'),
      complete: translate('pageStyle.batchPreview.confirmation.complete'),
      partial: translate('pageStyle.batchPreview.confirmation.partial'),
    });
    const previewHost = createNoteStyleBatchPreviewHost(
      () => mountState.active,
      () => registration.isActive(),
    );
    let activePreviewLease: PluginNoteStyleBatchPreviewLease | null = null;
    let stopActivePreviewLease: (() => void) | null = null;
    const detachActivePreviewLease = () => {
      stopActivePreviewLease?.();
      stopActivePreviewLease = null;
      activePreviewLease = null;
    };
    const batchPreview = Object.freeze({
      create(mode: Parameters<typeof previewHost.create>[0]) {
        if (!mountState.active || !registration.isActive()) return null;
        const lease = previewHost.create(mode);
        activePreviewLease = lease;
        stopActivePreviewLease = lease?.subscribe(() => {
          if (!lease.isCurrent() && activePreviewLease === lease) detachActivePreviewLease();
        }) ?? null;
        return lease;
      },
      invalidate() {
        detachActivePreviewLease();
        previewHost.invalidate();
      },
    });
    const batchPreviewConfirmation = Object.freeze({
      labels: confirmationLabels,
      confirm(lease: PluginNoteStyleBatchPreviewLease) {
        if (!mountState.active || !registration.isActive() || activePreviewLease !== lease)
          return Promise.resolve(null);
        detachActivePreviewLease();
        return confirmNoteStyleBatchPreview(lease);
      },
    });
    const unavailable = (): PluginNoteStylePanelResult => ({
      ok: false as const,
      code: 'save-failed',
      message: labels.saveFailed,
    });
    const host: PluginNoteStyleDefaultsPanelHost = Object.freeze({
      initial: Object.freeze(copyStyle(initialStyle)),
      labels,
      readInitial() {
        const current = getPreferences();
        return Object.freeze(copyStyle(
          resolveDefaultNoteStyle(current.defaultNoteStyle, current.font, current.width),
        ));
      },
      subscribeInitial(listener: () => void) {
        let lastKey = JSON.stringify([
          initialPreferences.font,
          initialPreferences.width,
          initialPreferences.defaultNoteStyle,
        ]);
        return subscribePreferences(() => {
          const current = getPreferences();
          const key = JSON.stringify([current.font, current.width, current.defaultNoteStyle]);
          if (key === lastKey) return;
          lastKey = key;
          listener();
        });
      },
      batchPreview,
      batchPreviewLabels,
      batchPreviewConfirmation,
      async save(style: NoteStyle) {
        if (!mountState.active || !registration.isActive() || !isValidNoteStyleInput(style))
          return unavailable();
        const saved = copyStyle(style);
        setPreferences({ defaultNoteStyle: saved });
        return {
          ok: true as const,
          style: copyStyle(saved),
          message: t('pageStyle.defaultSaved', undefined, preferences.locale),
        };
      },
      async restore() {
        if (!mountState.active || !registration.isActive()) return unavailable();
        const current = getPreferences();
        setPreferences({ defaultNoteStyle: undefined });
        const restored = resolveDefaultNoteStyle(undefined, current.font, current.width);
        return {
          ok: true as const,
          style: copyStyle(restored),
          message: t('pageStyle.defaultReset', undefined, preferences.locale),
        };
      },
      cancel() {
        // The plugin owns the uncommitted form draft; it changes the profile only on Save.
      },
    });

    let unmount: void | (() => void);
    try {
      unmount = registration.mount(container, host);
    } catch {
      mountState.active = false;
      batchPreview.invalidate();
      container.setAttribute('role', 'alert');
      container.textContent = labels.saveFailed;
      return () => {
        mountState.active = false;
        batchPreview.invalidate();
        container.replaceChildren();
      };
    }

    return () => {
      mountState.active = false;
      batchPreview.invalidate();
      try {
        if (typeof unmount === 'function') unmount();
      } finally {
        container.replaceChildren();
      }
    };
  }, [defaultProfileRefreshKey, labels, preferences.locale, registration]);

  if (!registration) return null;
  return (
    <SettingsGroup
      title={t('pageStyle.defaultsTitle', undefined, preferences.locale)}
      help={t('pageStyle.defaultsHelp', undefined, preferences.locale)}
    >
      <div ref={containerRef} />
    </SettingsGroup>
  );
}
