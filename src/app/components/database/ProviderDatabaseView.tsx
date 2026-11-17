import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { PageMeta } from '../../../core/model';
import { createPilotDataBackend } from '../../../storage/pilotData';
import { t } from '../../i18n';
import { usePreferences } from '../../platform/preferences';
import { openPage } from '../../router';
import { getSession, useWorkspace } from '../../workspace';
import { createProviderDataScope } from '../../plugins/providerDataScope';
import {
  databaseProvidersVersion,
  getDatabaseProvider,
  registerMountedDatabaseProvider,
  subscribeDatabaseProviders,
} from '../../plugins/providerRegistry';
import type { RegisteredDatabaseProvider } from '../../plugins/providerRegistry';
import { selectedProviderMarker } from '../../plugins/providerMarker';

interface MountStatus {
  readonly provider: RegisteredDatabaseProvider;
  readonly databaseId: string;
  readonly locale: string;
  readonly editable: boolean;
  readonly failed: boolean;
  readonly diagnostic: string | null;
}

export function ProviderDatabaseView({ page, editable }: { page: PageMeta; editable: boolean }) {
  useSyncExternalStore(subscribeDatabaseProviders, databaseProvidersVersion, databaseProvidersVersion);
  const prefs = usePreferences();
  const locale = prefs.locale;
  const effectiveEditable = editable && !prefs.readingMode;
  const selection = selectedProviderMarker(page.extra.polarisDados);
  const provider = selection ? getDatabaseProvider(selection.provider) : null;
  const elementRef = useRef<HTMLDivElement>(null);
  const [mountStatus, setMountStatus] = useState<MountStatus | null>(null);
  const statusMatches = Boolean(
    provider &&
      mountStatus?.provider === provider &&
      mountStatus.databaseId === page.id &&
      mountStatus.locale === locale &&
      mountStatus.editable === effectiveEditable,
  );

  useEffect(() => {
    if (!provider) return;
    const element = elementRef.current;
    if (!element) return;

    let active = true;
    let unmountProvider: (() => void) | undefined;
    const controller = new AbortController();
    const isCurrent = () =>
      active && provider.ownerIsActive() && getDatabaseProvider(provider.id) === provider;
    const scope = createProviderDataScope(provider.data, page.id, {
      isActive: isCurrent,
      editable: effectiveEditable,
    });
    const status = (failed: boolean, diagnostic: string | null = null): MountStatus => ({
      provider,
      databaseId: page.id,
      locale,
      editable: effectiveEditable,
      failed,
      diagnostic,
    });
    const deactivate = (failed = false, diagnostic: string | null = null) => {
      if (!active) return;
      active = false;
      controller.abort();
      try {
        scope.dispose();
      } catch {
        // A data listener cannot keep provider ownership active during cleanup.
      }
      try {
        unmountProvider?.();
      } catch {
        // A provider cleanup must not keep its root or API handle active.
      }
      try {
        unregisterRoot?.();
      } catch {
        // Continue clearing this root even if registry observers fail.
      }
      try {
        element.replaceChildren();
      } catch {
        // The root may already have been removed by React.
      }
      if (failed) setMountStatus(status(true, diagnostic));
    };

    const release = registerMountedDatabaseProvider(provider, page.id, element, () => deactivate());
    if (!release) {
      scope.dispose();
      return;
    }
    const unregisterRoot = release;

    try {
      if (!isCurrent()) throw new Error('The provider changed before its mount started.');
      const cleanup = provider.mount({
        element,
        databaseId: page.id,
        data: scope.api,
        locale,
        editable: effectiveEditable,
        signal: controller.signal,
      });
      if (cleanup !== undefined && typeof cleanup !== 'function')
        throw new Error('A provider mount must return a cleanup function or nothing.');
      unmountProvider = typeof cleanup === 'function' ? cleanup : undefined;
      if (!active) {
        unmountProvider?.();
        unmountProvider = undefined;
        return;
      }
      setMountStatus(status(false));
    } catch (error) {
      const diagnostic = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      deactivate(true, diagnostic);
    }

    return () => deactivate();
  }, [provider, page.id, locale, effectiveEditable]);

  if (
    !selection ||
    selection.provider !== 'polaris-dados' ||
    !provider ||
    (statusMatches && mountStatus?.failed)
  ) {
    return (
      <ProviderFallback
        page={page}
        locale={locale}
        diagnostic={statusMatches ? mountStatus?.diagnostic ?? null : null}
      />
    );
  }

  return (
    <div
      ref={elementRef}
      className="database database-provider-root"
      data-morrow-database-provider={provider.id}
      aria-busy={false}
    />
  );
}

function ProviderFallback({
  page,
  locale,
  diagnostic,
}: {
  page: PageMeta;
  locale: 'en' | 'es' | 'pt';
  diagnostic: string | null;
}) {
  const state = useWorkspace();
  const currentPage = state.pages[page.id] ?? page;
  const session = getSession();
  const marker = selectedProviderMarker(currentPage.extra.polarisDados);
  const message = diagnostic
    ? t('database.providerMountFailed', undefined, locale)
    : marker?.provider === 'polaris-dados'
      ? t('database.providerFallback', undefined, locale)
      : t('database.providerUnsupported', undefined, locale);

  if (session.unreadable.has(currentPage.id)) {
    const reason = session.protectedReasons.get(currentPage.id);
    return (
      <section className="database provider-fallback" aria-label={t('sidebar.database', undefined, locale)}>
        <p className="banner" role="note">{t('database.providerProtected', undefined, locale)}</p>
        <ProviderTechnicalDetails
          marker={currentPage.extra.polarisDados}
          locale={locale}
          diagnostic={diagnostic}
          reason={reason ?? null}
        />
      </section>
    );
  }

  const snapshot = createPilotDataBackend(session).snapshot(currentPage.id);
  if (marker?.provider !== 'polaris-dados' || snapshot.status !== 'ready') {
    const snapshotDiagnostic = snapshot.status === 'unsupported'
      ? snapshot.diagnostic.message
      : snapshot.status === 'missing'
        ? 'The opted-in database is not available in the provider snapshot.'
        : 'The database provider marker is not a supported version.';
    return (
      <section className="database provider-fallback" aria-label={t('sidebar.database', undefined, locale)}>
        <p className="banner" role="note">{t('database.providerProtected', undefined, locale)}</p>
        <ProviderTechnicalDetails
          marker={currentPage.extra.polarisDados}
          locale={locale}
          diagnostic={diagnostic ?? snapshotDiagnostic}
        />
      </section>
    );
  }

  const database = snapshot.schema;
  const rows = snapshot.rows;

  return (
    <section className="database provider-fallback" aria-label={t('sidebar.database', undefined, locale)}>
      <p className="banner" role="note">{message}</p>
      <ProviderTechnicalDetails marker={currentPage.extra.polarisDados} locale={locale} diagnostic={diagnostic} />
      <div className="table">
        <table>
          <thead>
            <tr>
              <th>{t('database.name', undefined, locale)}</th>
              {database.properties.map((property) => <th key={property.id}>{property.name}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <button type="button" className="link-button" onClick={() => openPage(row.id)}>
                    {row.title}
                  </button>
                </td>
                {database.properties.map((property) => (
                  <td key={property.id}>
                    {property.type === 'formula'
                      ? <code className="formula-source-literal">{property.formula ?? ''}</code>
                      : literalValue(row.properties[property.id] ?? null)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="db-count muted small">
        {rows.length === 1
          ? t('database.rowsOne', { count: rows.length }, locale)
          : t('database.rows', { count: rows.length }, locale)}
      </p>
    </section>
  );
}

function ProviderTechnicalDetails({
  marker,
  locale,
  diagnostic,
  reason = null,
}: {
  marker: unknown;
  locale: 'en' | 'es' | 'pt';
  diagnostic: string | null;
  reason?: string | null;
}) {
  const value = marker && typeof marker === 'object' ? marker as { provider?: unknown; version?: unknown } : {};
  const provider = typeof value.provider === 'string' ? value.provider : 'unknown';
  const version = typeof value.version === 'number' || typeof value.version === 'string'
    ? String(value.version)
    : 'unknown';
  return (
    <details className="provider-technical-details">
      <summary>{t('database.providerTechnicalDetails', undefined, locale)}</summary>
      <p>{t('database.providerMetadataDiagnostic', { provider, version }, locale)}</p>
      {diagnostic && <p>{t('database.providerMountDiagnostic', { message: diagnostic }, locale)}</p>}
      {reason && <pre className="readonly-text">{reason}</pre>}
    </details>
  );
}

function literalValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map((item) => String(item)).join(', ');
  return String(value);
}
