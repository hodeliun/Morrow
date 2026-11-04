import { ChevronLeft, ChevronRight, ExternalLink, Search } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { desktop } from '../platform/desktop';
import type { DesktopPdfViewerState } from '../platform/desktop';
import { usePreferences } from '../platform/preferences';
import { useTranslation } from '../i18n';
import { getSession } from '../workspace';
import { setActivePane, usePane } from '../tabs';
import { useUi } from '../ui';
import { observeOverlayLayers } from './layers';
import './pdfFileView.css';

const statuses = new Set(['loading', 'ready', 'invalid', 'password-required', 'unavailable', 'failed']);

function validState(state: DesktopPdfViewerState): boolean {
  return (
    !!state &&
    typeof state.viewerId === 'string' &&
    Number.isSafeInteger(state.sequence) &&
    state.sequence >= 0 &&
    statuses.has(state.status)
  );
}

export function PdfFileView({
  vaultId,
  path,
  visible,
}: {
  vaultId: string | null;
  path: string | null;
  visible: boolean;
}) {
  const { t, locale } = useTranslation();
  const ui = useUi();
  const preferences = usePreferences();
  const pane = usePane();
  const api = desktop?.pdfViewer;
  const host = useRef<HTMLDivElement>(null);
  const current = useRef<string | null>(null);
  const latestSequence = useRef(-1);
  const present = useRef<() => void>(() => undefined);
  const paneRef = useRef(pane);
  const visibleRef = useRef(false);
  const [state, setState] = useState<DesktopPdfViewerState | null>(null);
  const [openError, setOpenError] = useState<'unavailable' | 'failed' | null>(null);
  const [externalError, setExternalError] = useState(false);
  const [query, setQuery] = useState('');
  const [link, setLink] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(
    () => typeof matchMedia === 'function' && matchMedia('(max-width: 800px)').matches,
  );
  const name = path?.split('/').at(-1) ?? '';

  useEffect(() => {
    const media = matchMedia('(max-width: 800px)');
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  const sidebarBlocked =
    !ui.focusMode &&
    (narrow ? ui.mobileSidebar : !preferences.sidebarOpen && preferences.sidebarPeek && ui.sidebarPeek);

  useLayoutEffect(() => {
    paneRef.current = pane;
    visibleRef.current = visible && !sidebarBlocked;
    present.current();
  }, [pane, visible, sidebarBlocked]);

  useLayoutEffect(() => {
    present.current();
  }, [state?.status, link, openError, externalError, locale]);

  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !api) return;
    let overlayBlocked = false;
    let frame = 0;
    let disposed = false;
    const refresh = () => {
      if (disposed || !current.current) return;
      const ownPane = element.closest('.pane');
      const rect = element.getBoundingClientRect();
      const sidebar = document.querySelector<HTMLElement>('.sidebar');
      const sidebarRect = sidebar?.getBoundingClientRect();
      // Closing a sliding sidebar does not expose its pixels until the transition ends.
      const sidebarOverlaps =
        sidebar &&
        sidebarRect &&
        getComputedStyle(sidebar).visibility !== 'hidden' &&
        sidebarRect.width > 0 &&
        sidebarRect.height > 0 &&
        sidebarRect.right > rect.left &&
        sidebarRect.left < rect.right &&
        sidebarRect.bottom > rect.top &&
        sidebarRect.top < rect.bottom;
      const available =
        visibleRef.current &&
        !overlayBlocked &&
        document.visibilityState !== 'hidden' &&
        !sidebarOverlaps &&
        element.isConnected &&
        ownPane?.getAttribute('aria-hidden') !== 'true';
      const left = Math.max(0, rect.left),
        top = Math.max(0, rect.top);
      const right = Math.min(innerWidth, rect.right),
        bottom = Math.min(innerHeight, rect.bottom);
      const bounds =
        available && right > left && bottom > top
          ? { x: left, y: top, width: right - left, height: bottom - top }
          : null;
      try {
        api.present(current.current, bounds, bounds !== null);
      } catch {
        setOpenError('failed');
      }
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(refresh);
    };
    // Occlusion and document hiding cannot wait for a suspended animation frame.
    const visibility = () => (document.visibilityState === 'hidden' ? refresh() : schedule());
    present.current = refresh;
    const unsubscribe = observeOverlayLayers((blocked) => {
      overlayBlocked = blocked;
      refresh();
    });
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const ownPane = element.closest('.pane');
    const movement = new MutationObserver(schedule);
    if (ownPane)
      movement.observe(ownPane, {
        attributes: true,
        attributeFilter: ['style', 'class', 'data-pane', 'aria-hidden'],
      });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', visibility);
    document.addEventListener('transitionend', schedule, true);
    refresh();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      unsubscribe();
      resize.disconnect();
      movement.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', visibility);
      document.removeEventListener('transitionend', schedule, true);
      present.current = () => undefined;
      if (current.current) {
        try {
          api.present(current.current, null, false);
        } catch {
          /* Owner is already gone during teardown. */
        }
      }
    };
  }, [api]);

  useEffect(() => {
    if (!api || !vaultId || !path) return;
    let disposed = false;
    const session = getSession();
    const apply = (next: DesktopPdfViewerState) => {
      if (
        disposed ||
        getSession() !== session ||
        !validState(next) ||
        next.viewerId !== current.current ||
        next.sequence < latestSequence.current
      )
        return;
      latestSequence.current = next.sequence;
      setState(next);
    };
    const stopState = api.onState(apply);
    const stopFocus = api.onFocus((id) => {
      if (id === current.current && visibleRef.current && !disposed) setActivePane(paneRef.current);
    });
    const stopLink = api.onExternalLink((event) => {
      if (event.viewerId === current.current && !disposed && getSession() === session) setLink(event.url);
    });
    const stopVault = desktop?.imageViewer?.onVaultChanged(() => {
      disposed = true;
      const id = current.current;
      current.current = null;
      setLink(null);
      setState(null);
      setOpenError('failed');
      if (id) {
        try {
          api.present(id, null, false);
        } catch {
          /* The old owner can already be gone. */
        }
        void api.close(id).catch(() => undefined);
      }
    });
    void api
      .open(vaultId, path)
      .then(async (result) => {
        if (!result.ok) {
          if (!disposed && getSession() === session)
            setOpenError(result.code === 'file-unavailable' ? 'unavailable' : 'failed');
          return;
        }
        if (disposed || getSession() !== session) {
          await api.close(result.viewerId);
          return;
        }
        current.current = result.viewerId;
        apply(result.state);
        present.current();
        // Reconcile an event that arrived before the open reply without losing newer state.
        const snapshot = await api.getState(result.viewerId);
        if (snapshot) apply(snapshot);
      })
      .catch(() => {
        if (!disposed && getSession() === session) setOpenError('failed');
      });
    return () => {
      disposed = true;
      stopState();
      stopFocus();
      stopLink();
      stopVault?.();
      const id = current.current;
      current.current = null;
      if (id) {
        try {
          api.present(id, null, false);
        } catch {
          /* The owner is already gone during teardown. */
        }
        void api.close(id).catch(() => undefined);
      }
    };
  }, [api, vaultId, path]);

  useEffect(() => {
    if (!api || !state?.viewerId || state.status !== 'ready') return;
    const id = state.viewerId;
    const timer = setTimeout(() => {
      void api.find(id, query, true);
    }, 150);
    return () => clearTimeout(timer);
  }, [api, state?.viewerId, state?.status, query]);

  const find = (forward: boolean) => {
    if (api && current.current) void api.find(current.current, query, forward);
  };
  const openExternally = async () => {
    if (!path || !vaultId || !api) return;
    const session = getSession();
    try {
      const result = await api.openExternal(vaultId, path, locale);
      if (getSession() === session) setExternalError(!result.ok && result.code !== 'cancelled');
    } catch {
      if (getSession() === session) setExternalError(true);
    }
  };
  const status = openError ?? (!api || !vaultId || !path ? 'failed' : (state?.status ?? 'loading'));
  const message =
    status === 'password-required'
      ? t('pdfViewer.passwordRequired')
      : status === 'invalid'
        ? t('pdfViewer.invalid')
        : status === 'unavailable'
          ? t('pdfViewer.unavailable')
          : status === 'failed'
            ? t('pdfViewer.failed')
            : status === 'loading'
              ? t('pdfViewer.loading')
              : '';

  return (
    <section className="view pdf-file-view" data-pdf-status={status} data-pdf-viewer-id={state?.viewerId}>
      <header className="pdf-file-header">
        <strong title={name}>{name}</strong>
        <span className="pdf-file-metadata">
          application/pdf{state?.pageCount ? ` · ${t('pdfViewer.pages', { count: state.pageCount })}` : ''}
        </span>
        <button
          className="button small"
          type="button"
          onClick={() => void openExternally()}
          disabled={!path || !vaultId || !api}
        >
          <ExternalLink size={14} />
          {t('pdfViewer.openExternally')}
        </button>
      </header>
      <form
        className="pdf-find"
        onSubmit={(event) => {
          event.preventDefault();
          find(true);
        }}
      >
        <label>
          <Search size={14} />
          <input
            aria-label={t('pdfViewer.search')}
            placeholder={t('pdfViewer.search')}
            maxLength={512}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <span role="status">
          {state?.matches !== undefined
            ? t('pdfViewer.matches', { current: state.activeMatchOrdinal ?? 0, count: state.matches })
            : ''}
        </span>
        <button
          className="button small icon"
          type="button"
          aria-label={t('pdfViewer.previous')}
          onClick={() => find(false)}
          disabled={!query}
        >
          <ChevronLeft size={15} />
        </button>
        <button
          className="button small icon"
          type="submit"
          aria-label={t('pdfViewer.next')}
          disabled={!query}
        >
          <ChevronRight size={15} />
        </button>
      </form>
      {(message || externalError) && (
        <p className="pdf-file-status" role="status">
          {externalError ? t('pdfViewer.externalFailed') : message}
        </p>
      )}
      {link && (
        <div className="pdf-external-link" role="group" aria-label={t('pdfViewer.externalLink')}>
          <p>{t('pdfViewer.externalLink')}</p>
          <p className="pdf-link-address">{link}</p>
          <button
            className="button small"
            type="button"
            onClick={() => {
              const url = link;
              setLink(null);
              void desktop?.fileHandlers?.openUrl(url, { locale });
            }}
          >
            {t('pdfViewer.openLink')}
          </button>
          <button className="button small" type="button" onClick={() => setLink(null)}>
            {t('common.cancel')}
          </button>
        </div>
      )}
      <div className="pdf-native-host" ref={host} aria-label={t('pdfViewer.document')} />
    </section>
  );
}
