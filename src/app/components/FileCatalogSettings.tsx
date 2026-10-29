import { useEffect, useMemo, useState } from 'react';
import './fileCatalog.css';
import { fileCatalogExtensions, normalizeFileExtension } from '../../core/vault/fileCatalog';
import { useTranslation } from '../i18n';
import { desktop } from '../platform/desktop';
import type { DesktopFileHandlerMode, DesktopFileHandlerPreferences } from '../platform/desktop';
import { fileHandlerErrorKey } from '../platform/fileHandlerMessages';
import {
  fileCatalogExtensionPatch,
  resetFileCatalogPreferences,
  setFileCatalogPreferences,
  useFileCatalogPreferences,
} from '../platform/fileCatalogPreferences';
import { useFileCatalog } from '../workspace';
import { SettingRow, SettingsGroup } from './SettingsRows';
import { Switch } from './primitives';
import { toast } from '../ui';

export function FileCatalogSettings({ location }: { location: string }) {
  const { t, locale } = useTranslation();
  const catalog = useFileCatalog();
  const fileHandlers = desktop?.fileHandlers;
  const preferences = useFileCatalogPreferences(location);
  const [search, setSearch] = useState('');
  const [newExtension, setNewExtension] = useState('');
  const [handlerPreferences, setHandlerPreferences] = useState<DesktopFileHandlerPreferences | null>(null);
  const [handlerPreferencesUnavailable, setHandlerPreferencesUnavailable] = useState(false);
  const [handlerPreferencesLoading, setHandlerPreferencesLoading] = useState(true);
  const extensions = useMemo(() => fileCatalogExtensions(catalog, preferences), [catalog, preferences]);
  const visibleExtensions = useMemo(
    () => extensions.filter((item) => item.includes(search.trim().replace(/^\./, '').toLowerCase())),
    [extensions, search],
  );

  useEffect(() => {
    let active = true;
    if (!fileHandlers)
      return () => {
        active = false;
      };
    void Promise.resolve()
      .then(() => fileHandlers.getPreferences())
      .then((result) => {
        if (!active) return;
        if (result.ok) {
          setHandlerPreferences(result.preferences);
          setHandlerPreferencesUnavailable(false);
        } else {
          setHandlerPreferences(null);
          setHandlerPreferencesUnavailable(true);
        }
      })
      .catch(() => {
        if (active) {
          setHandlerPreferences(null);
          setHandlerPreferencesUnavailable(true);
        }
      })
      .finally(() => {
        if (active) setHandlerPreferencesLoading(false);
      });
    return () => {
      active = false;
    };
  }, [fileHandlers]);

  const refreshHandlerPreferences = async () => {
    if (!fileHandlers) return;
    setHandlerPreferencesLoading(true);
    try {
      const result = await fileHandlers.getPreferences();
      if (result.ok) {
        setHandlerPreferences(result.preferences);
        setHandlerPreferencesUnavailable(false);
        return;
      }
      setHandlerPreferences(null);
      setHandlerPreferencesUnavailable(true);
      toast(t(fileHandlerErrorKey(result.code)), { tone: 'error' });
    } catch {
      setHandlerPreferences(null);
      setHandlerPreferencesUnavailable(true);
      toast(t('fileCatalog.openFailed'), { tone: 'error' });
    } finally {
      setHandlerPreferencesLoading(false);
    }
  };

  const changeFileHandler = async (extension: string, mode: DesktopFileHandlerMode) => {
    if (!fileHandlers) return;
    try {
      const result = await fileHandlers.setFileHandler(`.${extension}`, mode, locale);
      if (!result.ok) {
        if (result.code !== 'cancelled') toast(t(fileHandlerErrorKey(result.code)), { tone: 'error' });
        return;
      }
      await refreshHandlerPreferences();
    } catch {
      toast(t('fileCatalog.openFailed'), { tone: 'error' });
    }
  };

  const changeBrowserHandler = async (mode: 'system' | 'application') => {
    if (!fileHandlers) return;
    try {
      const result = await fileHandlers.setBrowserHandler(mode, locale);
      if (!result.ok) {
        if (result.code !== 'cancelled') toast(t(fileHandlerErrorKey(result.code)), { tone: 'error' });
        return;
      }
      await refreshHandlerPreferences();
    } catch {
      toast(t('fileCatalog.openFailed'), { tone: 'error' });
    }
  };

  const toggleExtension = (extension: string, checked: boolean) => {
    setFileCatalogPreferences(location, fileCatalogExtensionPatch(preferences, extension, checked));
  };

  const addExtension = (event: React.FormEvent) => {
    event.preventDefault();
    const extension = normalizeFileExtension(newExtension);
    if (!extension) return;
    setFileCatalogPreferences(location, {
      customExtensions: [...preferences.customExtensions, extension],
      selectedExtensions: [...preferences.selectedExtensions, extension],
      hiddenExtensions: preferences.hiddenExtensions.filter((item) => item !== extension),
    });
    setNewExtension('');
  };

  return (
    <>
      <SettingsGroup title={t('fileCatalog.settingsTitle')} help={t('fileCatalog.settingsHelp')}>
        <SettingRow label={t('fileCatalog.visibilityMode')}>
          <div className="file-catalog-mode" role="radiogroup" aria-label={t('fileCatalog.visibilityMode')}>
            <button
              type="button"
              role="radio"
              aria-checked={preferences.mode === 'selected'}
              className={`button small${preferences.mode === 'selected' ? ' primary' : ''}`}
              onClick={() => setFileCatalogPreferences(location, { mode: 'selected' })}
            >
              {t('fileCatalog.selectedTypes')}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={preferences.mode === 'all'}
              className={`button small${preferences.mode === 'all' ? ' primary' : ''}`}
              onClick={() => setFileCatalogPreferences(location, { mode: 'all' })}
            >
              {t('fileCatalog.allTypes')}
            </button>
          </div>
        </SettingRow>
        <SettingRow label={t('fileCatalog.includeExtensionless')}>
          <Switch
            label={t('fileCatalog.includeExtensionless')}
            checked={preferences.includeExtensionless}
            onChange={(includeExtensionless) => setFileCatalogPreferences(location, { includeExtensionless })}
          />
        </SettingRow>
        <SettingRow label={t('fileCatalog.showAttachments')}>
          <Switch
            label={t('fileCatalog.showAttachments')}
            checked={preferences.showAttachments}
            onChange={(showAttachments) => setFileCatalogPreferences(location, { showAttachments })}
          />
        </SettingRow>
        <SettingRow label={t('fileCatalog.searchExtensions')}>
          <input
            className="text-input small settings-input"
            type="search"
            value={search}
            aria-label={t('fileCatalog.searchExtensions')}
            placeholder={t('fileCatalog.searchPlaceholder')}
            onChange={(event) => setSearch(event.target.value)}
          />
        </SettingRow>
        <form className="file-catalog-add" onSubmit={addExtension}>
          <label className="settings-row-label" htmlFor="file-catalog-new-extension">
            {t('fileCatalog.addExtension')}
          </label>
          <div className="file-catalog-add-controls">
            <input
              id="file-catalog-new-extension"
              className="text-input small settings-input"
              value={newExtension}
              aria-label={t('fileCatalog.addExtension')}
              placeholder={t('fileCatalog.extensionPlaceholder')}
              maxLength={33}
              onChange={(event) => setNewExtension(event.target.value)}
            />
            <button type="submit" className="button small" disabled={!normalizeFileExtension(newExtension)}>
              {t('fileCatalog.addButton')}
            </button>
          </div>
        </form>
        <fieldset className="file-catalog-types">
          <legend>{t(preferences.mode === 'all' ? 'fileCatalog.hideTypes' : 'fileCatalog.showTypes')}</legend>
          <div className="file-catalog-type-list">
            {visibleExtensions.map((extension) => {
              const checked =
                preferences.mode === 'all'
                  ? preferences.hiddenExtensions.includes(extension)
                  : preferences.selectedExtensions.includes(extension);
              const label = t(preferences.mode === 'all' ? 'fileCatalog.hideType' : 'fileCatalog.showType', {
                extension: `.${extension}`,
              });
              return (
                <label className="file-catalog-type" key={extension}>
                  <input
                    type="checkbox"
                    checked={checked}
                    aria-label={label}
                    onChange={(event) => toggleExtension(extension, event.target.checked)}
                  />
                  <span>.{extension}</span>
                </label>
              );
            })}
            {visibleExtensions.length === 0 && (
              <p className="file-catalog-no-types">{t('fileCatalog.noTypes')}</p>
            )}
          </div>
        </fieldset>
        <div className="settings-actions">
          <button
            type="button"
            className="button small"
            onClick={() => resetFileCatalogPreferences(location)}
          >
            {t('fileCatalog.reset')}
          </button>
        </div>
      </SettingsGroup>
      <SettingsGroup
        title={t('fileCatalog.openingSettingsTitle')}
        help={t('fileCatalog.openingSettingsHelp')}
      >
        {!desktop?.fileHandlers ? (
          <p className="file-catalog-native-help">{t('fileCatalog.desktopOnly')}</p>
        ) : handlerPreferencesLoading ? (
          <p className="file-catalog-native-help" role="status" aria-live="polite">
            {t('fileCatalog.settingsLoading')}
          </p>
        ) : handlerPreferencesUnavailable || !handlerPreferences ? (
          <div className="file-catalog-native-help" role="alert">
            <p>{t('fileCatalog.settingsFailed')}</p>
            <button type="button" className="button small" onClick={() => void refreshHandlerPreferences()}>
              {t('fileCatalog.retrySettings')}
            </button>
          </div>
        ) : (
          <>
            <fieldset className="file-catalog-types">
              <legend>{t('fileCatalog.openingMethod')}</legend>
              <div className="file-catalog-handler-list">
                {visibleExtensions.map((extension) => {
                  const preference = handlerPreferences?.files[`.${extension}`];
                  const supportsInternal =
                    handlerPreferences?.internalExtensions.includes(`.${extension}`) ?? false;
                  return (
                    <div className="file-catalog-handler-row" key={`handler:${extension}`}>
                      <label htmlFor={`file-catalog-handler-${extension}`}>.{extension}</label>
                      <select
                        id={`file-catalog-handler-${extension}`}
                        className="text-input small settings-input"
                        aria-label={t('fileCatalog.handlerFor', { extension: `.${extension}` })}
                        value={preference?.mode ?? 'system'}
                        onChange={(event) =>
                          void changeFileHandler(extension, event.target.value as DesktopFileHandlerMode)
                        }
                      >
                        <option value="system">{t('fileCatalog.openWithSystem')}</option>
                        {supportsInternal && (
                          <option value="internal">{t('fileCatalog.openInternally')}</option>
                        )}
                        <option value="application">{t('fileCatalog.openWithApplication')}</option>
                      </select>
                      {preference?.needsReselection ? (
                        <small className="file-catalog-handler-detail">
                          {t('fileCatalog.applicationNeedsReselection')}
                        </small>
                      ) : preference?.applicationName ? (
                        <small className="file-catalog-handler-detail">{preference.applicationName}</small>
                      ) : null}
                      {preference?.mode === 'application' && (
                        <div className="file-catalog-handler-actions">
                          <button
                            type="button"
                            className="button small"
                            onClick={() => void changeFileHandler(extension, 'application')}
                          >
                            {t('fileCatalog.chooseAnotherApplication')}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {visibleExtensions.length === 0 && (
                  <p className="file-catalog-no-types">{t('fileCatalog.noTypes')}</p>
                )}
              </div>
            </fieldset>
            <SettingRow label={t('fileCatalog.browserPreference')}>
              <select
                className="text-input small settings-input"
                aria-label={t('fileCatalog.browserPreference')}
                value={handlerPreferences?.browser.mode ?? 'system'}
                onChange={(event) =>
                  void changeBrowserHandler(event.target.value as 'system' | 'application')
                }
              >
                <option value="system">{t('fileCatalog.openWithSystem')}</option>
                <option value="application">{t('fileCatalog.openWithApplication')}</option>
              </select>
            </SettingRow>
            {handlerPreferences?.browser.needsReselection ? (
              <p className="file-catalog-native-help">{t('fileCatalog.browserNeedsReselection')}</p>
            ) : handlerPreferences?.browser.applicationName ? (
              <p className="file-catalog-native-help">{handlerPreferences.browser.applicationName}</p>
            ) : null}
            {handlerPreferences?.browser.mode === 'application' && (
              <div className="settings-actions">
                <button
                  type="button"
                  className="button small"
                  onClick={() => void changeBrowserHandler('application')}
                >
                  {t('fileCatalog.chooseAnotherBrowser')}
                </button>
              </div>
            )}
          </>
        )}
      </SettingsGroup>
    </>
  );
}
