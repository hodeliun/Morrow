import { ArrowLeft, ArrowRight, ExternalLink, Globe, LoaderCircle, RotateCw, Square, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n';
import { desktop } from '../platform/desktop';
import type { BrowserTabState } from '../platform/desktop';
import { getTabForPane, getVisiblePanes, replaceBrowserTabTarget, setActivePane, usePaneTabId } from '../tabs';
import { observeBrowserPaneGeometry, observeBrowserTabPresentation } from './browserTabPresentation';
import './browserTab.css';

export function BrowserTabView({ url, visible }: { url: string | null; visible: boolean }) {
  const { t } = useTranslation();
  const tabId = usePaneTabId();
  const hostRef = useRef<HTMLDivElement>(null);
  const savedUrl = useRef(url);
  const [state, setState] = useState<BrowserTabState | null>(null);
  const [address, setAddress] = useState(url ?? '');
  const [confirmingClear, setConfirmingClear] = useState(false);
  const browser = desktop?.browserTabs;

  useLayoutEffect(() => {
    savedUrl.current = url;
  }, [url]);

  useEffect(() => {
    if (!browser || !tabId) return;
    let active = true;
    const accept = (next: BrowserTabState) => {
      if (!active || next.tabId !== tabId) return;
      setState(next);
      if (next.url !== null) replaceBrowserTabTarget(tabId, next.url);
      if (next.url !== null) setAddress(next.url);
      else if (next.status === 'idle' && savedUrl.current) setAddress(savedUrl.current);
    };
    const unsubscribe = browser.onState(accept);
    const unsubscribeFocus = browser.onFocus((focusedTabId) => {
      if (focusedTabId !== tabId) return;
      const pane = getVisiblePanes().find((candidate) => candidate.tabId === focusedTabId);
      if (!pane || getTabForPane(pane.id)?.id !== focusedTabId) return;
      setActivePane(pane.id);
    });
    void browser.getState(tabId).then(accept).catch(() => undefined);
    return () => {
      active = false;
      unsubscribe();
      unsubscribeFocus();
      void browser.release(tabId);
    };
  }, [browser, tabId]);

  useLayoutEffect(() => {
    const element = hostRef.current;
    if (!element || !browser || !tabId) return;
    const presentation = observeBrowserTabPresentation({
      present: (presentTabId, bounds, requestedVisible) => {
        void browser.present(presentTabId, bounds, requestedVisible);
      },
      tabId,
      element,
      paneVisible: visible,
    });
    const pane = element.closest<HTMLElement>('.pane');
    const stopPaneGeometry = pane ? observeBrowserPaneGeometry(pane, presentation.refresh) : () => undefined;
    const observer = new ResizeObserver(presentation.refresh);
    observer.observe(element);
    window.addEventListener('resize', presentation.refresh);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', presentation.refresh);
      stopPaneGeometry();
      presentation.dispose();
    };
  }, [browser, tabId, visible]);

  const navigate = (value: string) => {
    if (!browser || !tabId) return;
    void browser.navigate(tabId, value).then((next) => {
      setState(next);
      if (next.url !== null) setAddress(next.url);
    });
  };

  const command = (name: 'back' | 'forward' | 'reload' | 'stop') => {
    if (!browser || !tabId) return;
    void browser.command(tabId, name).then(setState);
  };

  const errorMessage = state?.error
    ? t(
        state.error === 'invalid-url'
          ? 'browserTabs.invalidUrl'
          : state.error === 'url-too-long'
            ? 'browserTabs.urlTooLong'
            : state.error === 'navigation-blocked'
              ? 'browserTabs.blocked'
              : 'browserTabs.loadFailed',
      )
    : null;
  const restoredAddressNeedsActivation = Boolean(
    url !== null &&
      state !== null &&
      state.url === null &&
      (state.status === 'idle' || state.status === 'error'),
  );
  const hasRuntimePage = Boolean(state?.url);

  return (
    <section className="view browser-tab-view" aria-label={t('browserTabs.title')}>
      <div className="browser-tab-toolbar">
        <button
          type="button"
          className="browser-tab-action"
          aria-label={t('browserTabs.back')}
          title={t('browserTabs.back')}
          disabled={!state?.canGoBack}
          onClick={() => command('back')}
        >
          <ArrowLeft size={15} />
        </button>
        <button
          type="button"
          className="browser-tab-action"
          aria-label={t('browserTabs.forward')}
          title={t('browserTabs.forward')}
          disabled={!state?.canGoForward}
          onClick={() => command('forward')}
        >
          <ArrowRight size={15} />
        </button>
        {state?.status === 'loading' ? (
          <button
            type="button"
            className="browser-tab-action"
            aria-label={t('browserTabs.stop')}
            title={t('browserTabs.stop')}
            onClick={() => command('stop')}
          >
            <Square size={13} />
          </button>
        ) : (
          <button
            type="button"
            className="browser-tab-action"
            aria-label={t('browserTabs.reload')}
            title={t('browserTabs.reload')}
            disabled={!hasRuntimePage}
            onClick={() => command('reload')}
          >
            <RotateCw size={14} />
          </button>
        )}
        <form
          className="browser-tab-address-form"
          onSubmit={(event) => {
            event.preventDefault();
            navigate(address);
          }}
        >
          <label className="browser-tab-address-label" htmlFor={`browser-address-${tabId ?? 'empty'}`}>
            <Globe size={14} />
            <span className="visually-hidden">{t('browserTabs.address')}</span>
          </label>
          <input
            id={`browser-address-${tabId ?? 'empty'}`}
            className="browser-tab-address-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={address}
            placeholder={t('browserTabs.addressPlaceholder')}
            onChange={(event) => setAddress(event.currentTarget.value)}
          />
          <button type="submit" className="browser-tab-go">
            {t('browserTabs.go')}
          </button>
        </form>
        <div className="browser-tab-page-title" title={state?.title ?? undefined}>
          {state?.status === 'loading' ? <LoaderCircle className="browser-tab-spinner" size={14} /> : null}
          <span>{state?.title ?? ''}</span>
        </div>
        <button
          type="button"
          className="browser-tab-action"
          aria-label={t('browserTabs.openExternal')}
          title={t('browserTabs.openExternal')}
          disabled={!browser || !tabId || !state?.url}
          onClick={() => {
            if (!browser || !tabId) return;
            void browser.openExternal(tabId).then((externalUrl) => {
              if (externalUrl) void desktop?.openExternal(externalUrl);
            });
          }}
        >
          <ExternalLink size={14} />
        </button>
        <button
          type="button"
          className="browser-tab-action"
          aria-label={t('browserTabs.clearSiteData')}
          title={t('browserTabs.clearSiteData')}
          disabled={!browser}
          onClick={() => setConfirmingClear(true)}
        >
          <X size={15} />
        </button>
      </div>

      {confirmingClear && (
        <div className="browser-tab-clear-confirm" role="group" aria-label={t('browserTabs.clearSiteData')}>
          <span>{t('browserTabs.confirmClearSiteData')}</span>
          <button
            type="button"
            className="button small danger"
            onClick={() => {
              setConfirmingClear(false);
              void browser?.clearSiteData().then(() => {
                setState(null);
                setAddress('');
              });
            }}
          >
            {t('browserTabs.confirmClear')}
          </button>
          <button type="button" className="button small" onClick={() => setConfirmingClear(false)}>
            {t('browserTabs.cancelClear')}
          </button>
        </div>
      )}

      {errorMessage ? (
        <div className="browser-tab-notice is-error" role="alert">{errorMessage}</div>
      ) : state?.warnings.length ? (
        <div className="browser-tab-notice" role="status">
          {state.warnings.map((warning) => (
            <span key={warning}>
              {warning === 'http' ? t('browserTabs.warningHttp') : t('browserTabs.warningEphemeral')}
            </span>
          ))}
        </div>
      ) : null}

      {state?.mediaPauseFailed ? (
        <div className="browser-tab-notice is-error" role="alert">
          {t('browserTabs.mediaPauseFailed')}
        </div>
      ) : null}

      <div ref={hostRef} className="browser-tab-content" aria-label={t('browserTabs.status')}>
        {!browser ? (
          <div className="browser-tab-placeholder">
            <h2>{t('browserTabs.unavailable')}</h2>
          </div>
        ) : restoredAddressNeedsActivation ? (
          <div className="browser-tab-placeholder">
            <h2>{t('browserTabs.restoreTitle')}</h2>
            <p>{t('browserTabs.restorePrompt')}</p>
            <button type="button" className="button" onClick={() => navigate(url!)}>
              {t('browserTabs.restore')}
            </button>
          </div>
        ) : !hasRuntimePage && !errorMessage ? (
          <div className="browser-tab-placeholder">
            <h2>{t('browserTabs.enterAddress')}</h2>
          </div>
        ) : null}
      </div>
    </section>
  );
}
