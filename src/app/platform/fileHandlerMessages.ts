import type { TranslationKey } from '../i18n';

const messages: Record<string, TranslationKey> = {
  'application-invalid': 'fileCatalog.applicationInvalid',
  'application-missing': 'fileCatalog.applicationMissing',
  cancelled: 'fileCatalog.selectionCancelled',
  'device-identity-unavailable': 'fileCatalog.deviceIdentityUnavailable',
  'device-mismatch': 'fileCatalog.deviceMismatch',
  'internal-viewer-unavailable': 'fileCatalog.internalViewerUnavailable',
  'invalid-extension': 'fileCatalog.invalidExtension',
  'invalid-mode': 'fileCatalog.invalidMode',
  'invalid-request': 'fileCatalog.invalidRequest',
  'invalid-resource': 'fileCatalog.invalidResource',
  'invalid-url': 'fileCatalog.invalidUrl',
  'launch-failed': 'fileCatalog.launchFailed',
  'no-association': 'fileCatalog.noAssociation',
  'not-allowed': 'fileCatalog.notAllowed',
  'open-failed': 'fileCatalog.openFailed',
  'open-folder-failed': 'fileCatalog.openFolderFailed',
  'settings-read-failed': 'fileCatalog.settingsFailed',
  'settings-write-failed': 'fileCatalog.settingsFailed',
  'vault-changed': 'fileCatalog.vaultChanged',
};

export function fileHandlerErrorKey(code: string): TranslationKey {
  return messages[code] ?? 'fileCatalog.openFailed';
}
