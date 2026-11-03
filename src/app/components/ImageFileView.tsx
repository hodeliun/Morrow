import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { affectsImageFile } from '../imageFileChanges';
import { desktop } from '../platform/desktop';
import { useTranslation } from '../i18n';
import './imageFileView.css';

interface ImageResource {
  readonly token: string;
  readonly mimeType: string;
  readonly size: number;
}

function filename(relativePath: string | null): string {
  return relativePath?.split('/').at(-1) || '';
}

function imageUrl(vaultId: string, token: string): string {
  return `morrow-image://vault/${vaultId}/${token}`;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImageFileView({ vaultId, path }: { vaultId: string | null; path: string | null }) {
  const { t } = useTranslation();
  const viewer = desktop?.imageViewer;
  const vault = desktop?.vault;
  const [resource, setResource] = useState<ImageResource | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [fit, setFit] = useState(true);
  const tokenRef = useRef<string | null>(null);
  const name = filename(path);

  useEffect(() => {
    if (!vaultId || !path || !viewer) return;

    let disposed = false;
    let requestId = 0;
    tokenRef.current = null;
    const acquire = async () => {
      const currentRequest = ++requestId;
      try {
        const result = await viewer.issue(vaultId, path);
        if (disposed || currentRequest !== requestId) {
          if (result.ok) void viewer.release(result.token).catch(() => false);
          return;
        }
        if (!result.ok) {
          setError(result.code);
          return;
        }
        tokenRef.current = result.token;
        setError(null);
        setResource({ token: result.token, mimeType: result.mimeType, size: result.size });
      } catch {
        if (!disposed && currentRequest === requestId) setError('invalid-resource');
      }
    };
    const onVaultChanged = async () => {
      const currentRequest = ++requestId;
      const token = tokenRef.current;
      tokenRef.current = null;
      if (token) void viewer.release(token).catch(() => false);
      setResource(null);
      setNaturalSize(null);
      setError(null);
      try {
        const identity = await viewer.getVaultId();
        if (disposed || currentRequest !== requestId) return;
        if (!identity.ok) setError(identity.code);
        else if (identity.vaultId !== vaultId) setError('vault-changed');
        else void acquire();
      } catch {
        if (!disposed && currentRequest === requestId) setError('no-vault');
      }
    };
    const stopVaultListener = viewer.onVaultChanged(() => void onVaultChanged());
    const stopFileListener = vault?.onChanges((changes) => {
      if (affectsImageFile(changes, path)) void onVaultChanged();
    });
    void acquire();

    return () => {
      disposed = true;
      requestId += 1;
      stopVaultListener();
      stopFileListener?.();
      const token = tokenRef.current;
      tokenRef.current = null;
      if (token) void viewer.release(token).catch(() => false);
    };
  }, [path, vault, vaultId, viewer]);

  const setZoom = (next: number) => {
    const bounded = Math.max(0.1, Math.min(8, Math.round(next * 10) / 10));
    setScale(bounded);
    setFit(false);
  };

  const fitImage = () => {
    setScale(1);
    setFit(true);
  };

  const onStageKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      setZoom(scale + 0.25);
    } else if (event.key === '-') {
      event.preventDefault();
      setZoom(scale - 0.25);
    } else if (event.key === '0') {
      event.preventDefault();
      fitImage();
    }
  };

  const errorText = error
    ? error === 'vault-changed'
      ? t('fileViewer.vaultChanged')
      : error === 'no-vault'
        ? t('fileViewer.noVault')
        : error === 'not-allowed'
          ? t('fileViewer.unavailable')
          : t('fileViewer.missing')
    : !vaultId || !path || !viewer
      ? t('fileViewer.unavailable')
      : null;

  const onImageError = () => {
    const token = tokenRef.current;
    tokenRef.current = null;
    if (token && viewer) void viewer.release(token).catch(() => false);
    setResource(null);
    setError('invalid-resource');
  };

  return (
    <section className="view image-file-view" aria-label={t('fileViewer.title')}>
      <header className="image-file-toolbar">
        <div className="image-file-details">
          <strong className="image-file-name" title={name}>
            {name || t('fileViewer.title')}
          </strong>
          {naturalSize && (
            <span className="image-file-metadata">
              {t('fileViewer.dimensions', { width: naturalSize.width, height: naturalSize.height })}
              {resource ? ` · ${formatBytes(resource.size)}` : ''}
              {resource ? ` · ${resource.mimeType}` : ''}
            </span>
          )}
        </div>
        <div className="image-file-controls" aria-label={t('fileViewer.controls')}>
          <button
            type="button"
            className="icon-button small"
            aria-label={t('fileViewer.zoomOut')}
            title={t('fileViewer.zoomOut')}
            disabled={!resource}
            onClick={() => setZoom(scale - 0.25)}
          >
            <ZoomOut size={15} />
          </button>
          <span className="image-file-zoom" aria-live="polite">
            {fit ? t('fileViewer.fit') : `${Math.round(scale * 100)}%`}
          </span>
          <button
            type="button"
            className="icon-button small"
            aria-label={t('fileViewer.zoomIn')}
            title={t('fileViewer.zoomIn')}
            disabled={!resource}
            onClick={() => setZoom(scale + 0.25)}
          >
            <ZoomIn size={15} />
          </button>
          <button
            type="button"
            className="icon-button small"
            aria-label={t('fileViewer.fit')}
            title={t('fileViewer.fit')}
            disabled={!resource}
            onClick={fitImage}
          >
            <Maximize2 size={15} />
          </button>
        </div>
      </header>
      <div
        className="image-file-stage"
        role="group"
        aria-label={t('fileViewer.imageStage', { name: name || t('fileViewer.title') })}
        tabIndex={0}
        onKeyDown={onStageKeyDown}
        aria-busy={!resource && !errorText}
      >
        {errorText ? (
          <p className="image-file-error" role="alert">
            {errorText}
          </p>
        ) : resource && vaultId ? (
          <img
            className={`image-file-image${fit ? ' is-fit' : ' is-zoomed'}`}
            src={imageUrl(vaultId, resource.token)}
            alt={name}
            draggable={false}
            style={
              !fit && naturalSize
                ? {
                    width: `${Math.round(naturalSize.width * scale)}px`,
                    height: `${Math.round(naturalSize.height * scale)}px`,
                  }
                : undefined
            }
            onLoad={(event) =>
              setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
            onError={onImageError}
          />
        ) : (
          <p className="image-file-loading" role="status">
            {t('fileViewer.loading')}
          </p>
        )}
      </div>
    </section>
  );
}
