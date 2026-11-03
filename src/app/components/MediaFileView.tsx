import { Maximize, Minimize, Pause, Play, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { affectsMediaFile } from '../mediaFileChanges';
import { resolveMediaAvailabilityNotice, retireFailedMediaResource } from '../mediaAvailability';
import { desktop } from '../platform/desktop';
import type { DesktopMediaViewerIssueResult } from '../platform/desktop';
import { useTranslation } from '../i18n';
import { ImageFileView } from './ImageFileView';
import './mediaFileView.css';

type IssuedMedia = Extract<DesktopMediaViewerIssueResult, { ok: true }>;
type ViewState =
  | { kind: 'loading' }
  | { kind: 'media'; resource: IssuedMedia }
  | { kind: 'image' }
  | { kind: 'error'; code: string };

function filename(relativePath: string | null): string {
  return relativePath?.split('/').at(-1) || '';
}

function mediaUrl(vaultId: string, token: string): string {
  return `morrow-media://vault/${vaultId}/${token}`;
}

function timeLabel(seconds: number, locale: string): string {
  const safeSeconds = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  const number = new Intl.NumberFormat(locale, { minimumIntegerDigits: 2, useGrouping: false });
  return `${number.format(minutes)}:${number.format(remainder)}`;
}

function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))
  );
}

export function MediaFileView({ vaultId, path }: { vaultId: string | null; path: string | null }) {
  const { t, locale } = useTranslation();
  const viewer = desktop?.mediaViewer;
  const imageViewer = desktop?.imageViewer;
  const vault = desktop?.vault;
  const [view, setView] = useState<ViewState>(() =>
    !vaultId
      ? { kind: 'error', code: 'no-vault' }
      : !path || !viewer
        ? { kind: 'error', code: 'unavailable' }
        : { kind: 'loading' },
  );
  const [playbackError, setPlaybackError] = useState(false);
  const [externalError, setExternalError] = useState(false);
  const [fullscreenError, setFullscreenError] = useState(false);
  const [paused, setPaused] = useState(true);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [fullscreen, setFullscreen] = useState(false);
  const rootRef = useRef<HTMLElement>(null);
  const mediaRef = useRef<HTMLMediaElement>(null);
  const tokenRef = useRef<string | null>(null);
  const availabilityTokenRef = useRef<string | null>(null);
  const failureDisplayRef = useRef<'decode-error' | 'file-unavailable' | null>(null);
  const name = filename(path);

  useEffect(() => {
    if (!vaultId || !path || !viewer) return;

    const rootElement = rootRef.current;
    let disposed = false;
    let active = false;
    let requestId = 0;
    const releaseCurrent = () => {
      const token = tokenRef.current;
      tokenRef.current = null;
      availabilityTokenRef.current = null;
      failureDisplayRef.current = null;
      if (token) void viewer.release(token).catch(() => false);
    };
    const issue = async () => {
      if (disposed || !active) return;
      const currentRequest = ++requestId;
      setView({ kind: 'loading' });
      setPlaybackError(false);
      failureDisplayRef.current = null;
      setFullscreenError(false);
      setExternalError(false);
      try {
        const result = await viewer.issue(vaultId, path);
        if (disposed || currentRequest !== requestId || !active) {
          if (result.ok) void viewer.release(result.token).catch(() => false);
          return;
        }
        if (!result.ok) {
          setView(result.code === 'unsupported-type' ? { kind: 'image' } : { kind: 'error', code: result.code });
          return;
        }
        tokenRef.current = result.token;
        availabilityTokenRef.current = result.token;
        setView({ kind: 'media', resource: result });
      } catch {
        if (!disposed && currentRequest === requestId) setView({ kind: 'error', code: 'invalid-resource' });
      }
    };
    const releaseAndPause = () => {
      requestId += 1;
      mediaRef.current?.pause();
      if (document.fullscreenElement === rootElement)
        void document.exitFullscreen().catch(() => undefined);
      releaseCurrent();
      setView({ kind: 'loading' });
      setPlaybackError(false);
      setFullscreenError(false);
      setExternalError(false);
      setPaused(true);
      setPosition(0);
      setDuration(0);
      setVolume(1);
      setPlaybackRate(1);
    };
    const isPaneVisible = () => {
      const pane = rootElement?.closest<HTMLElement>('.pane');
      return (
        document.visibilityState !== 'hidden' &&
        (!pane ||
          (pane.getAttribute('aria-hidden') !== 'true' &&
            !pane.classList.contains('is-cached') &&
            getComputedStyle(pane).display !== 'none'))
      );
    };
    const reconcileVisibility = () => {
      const nextActive = isPaneVisible();
      if (nextActive === active) return;
      active = nextActive;
      if (active) void issue();
      else releaseAndPause();
    };
    const refresh = () => {
      if (!active) return;
      releaseAndPause();
      void issue();
    };
    const onVaultChanged = async () => {
      if (!active) return;
      releaseAndPause();
      const currentRequest = requestId;
      try {
        const identity = await imageViewer?.getVaultId();
        if (disposed || currentRequest !== requestId) return;
        if (!identity?.ok || identity.vaultId !== vaultId) {
          setView({ kind: 'error', code: identity?.ok ? 'vault-changed' : identity?.code ?? 'no-vault' });
          return;
        }
        void issue();
      } catch {
        if (!disposed && currentRequest === requestId) setView({ kind: 'error', code: 'no-vault' });
      }
    };
    const stopAvailability = viewer.onAvailability((notice) => {
      const availability = resolveMediaAvailabilityNotice(
        failureDisplayRef.current,
        availabilityTokenRef.current,
        disposed,
        active,
        notice,
      );
      if (!availability.accepted) return;
      mediaRef.current?.pause();
      tokenRef.current = null;
      availabilityTokenRef.current = null;
      failureDisplayRef.current = availability.display;
      setPlaybackError(false);
      setView({ kind: 'error', code: 'file-unavailable' });
      void viewer.release(notice.token).catch(() => false);
    });

    const pane = rootRef.current?.closest<HTMLElement>('.pane');
    const observer = pane ? new MutationObserver(reconcileVisibility) : null;
    observer?.observe(pane!, { attributes: true, attributeFilter: ['aria-hidden', 'class', 'style'] });
    document.addEventListener('visibilitychange', reconcileVisibility);
    const stopVault = viewer.onVaultChanged(() => void onVaultChanged());
    const stopChanges = vault?.onChanges((changes) => {
      if (affectsMediaFile(changes, path)) refresh();
    });
    reconcileVisibility();

    return () => {
      disposed = true;
      requestId += 1;
      observer?.disconnect();
      document.removeEventListener('visibilitychange', reconcileVisibility);
      stopVault();
      stopAvailability();
      stopChanges?.();
      mediaRef.current?.pause();
      if (document.fullscreenElement === rootElement)
        void document.exitFullscreen().catch(() => undefined);
      releaseCurrent();
    };
  }, [imageViewer, path, vault, vaultId, viewer]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = Boolean(rootRef.current && document.fullscreenElement === rootRef.current);
      setFullscreen(active);
      if (active) setFullscreenError(false);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const syncMediaState = () => {
    const media = mediaRef.current;
    if (!media) return;
    setPaused(media.paused);
    setPosition(Number.isFinite(media.currentTime) ? media.currentTime : 0);
    setDuration(Number.isFinite(media.duration) ? media.duration : 0);
    setVolume(media.volume);
    setPlaybackRate(media.playbackRate);
  };

  const togglePlayback = () => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.paused)
      void media.play().catch(() => {
        failureDisplayRef.current = 'decode-error';
        setPlaybackError(true);
      });
    else media.pause();
  };

  const toggleFullscreen = async () => {
    const root = rootRef.current;
    if (!root || view.kind !== 'media' || view.resource.kind !== 'video') return;
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
      else await root.requestFullscreen();
    } catch {
      setFullscreenError(true);
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || isTextEntry(event.target)) return;
    if (event.key.toLowerCase() === 'f' && view.kind === 'media' && view.resource.kind === 'video') {
      event.preventDefault();
      void toggleFullscreen();
    } else if (event.key === 'Escape' && document.fullscreenElement === rootRef.current) {
      event.preventDefault();
      void document.exitFullscreen().catch(() => undefined);
    }
  };

  const failPlayback = (token: string) => {
    const transition = retireFailedMediaResource(
      { resourceToken: tokenRef.current, availabilityToken: availabilityTokenRef.current },
      token,
    );
    if (!transition.releaseToken) return;
    setPlaybackError(true);
    failureDisplayRef.current = 'decode-error';
    tokenRef.current = transition.tokens.resourceToken;
    availabilityTokenRef.current = transition.tokens.availabilityToken;
    mediaRef.current?.pause();
    if (viewer) void viewer.release(transition.releaseToken).catch(() => false);
  };

  const openExternally = async () => {
    if (!path || !vault) return;
    mediaRef.current?.pause();
    if (document.fullscreenElement === rootRef.current)
      void document.exitFullscreen().catch(() => undefined);
    const token = tokenRef.current;
    tokenRef.current = null;
    availabilityTokenRef.current = null;
    if (token && viewer) void viewer.release(token).catch(() => false);
    try {
      const opened = await vault.openFile(path);
      setExternalError(!opened);
      if (opened) setView({ kind: 'error', code: 'external-open' });
    } catch {
      setExternalError(true);
    }
  };

  if (view.kind === 'image') return <ImageFileView vaultId={vaultId} path={path} />;

  const errorText = view.kind === 'error'
    ? view.code === 'no-vault'
      ? t('mediaViewer.noVault')
      : view.code === 'vault-changed'
        ? t('mediaViewer.vaultChanged')
        : view.code === 'external-open'
          ? t('mediaViewer.externalOpened')
          : view.code === 'file-unavailable'
            ? t('mediaViewer.fileUnavailable')
          : view.code === 'unavailable' || view.code === 'not-allowed'
            ? t('mediaViewer.unavailable')
            : t('mediaViewer.missing')
    : playbackError
      ? t('mediaViewer.decodeError')
      : null;

  return (
    <section
      ref={rootRef}
      className={`view media-file-view${fullscreen ? ' is-fullscreen' : ''}`}
      aria-label={t('mediaViewer.title')}
      onKeyDown={onKeyDown}
      tabIndex={0}
    >
      <header className="media-file-header">
        <div className="media-file-details">
          <strong className="media-file-name" title={name}>{name || t('mediaViewer.title')}</strong>
          {view.kind === 'media' && (
            <span className="media-file-metadata">{view.resource.mimeType}</span>
          )}
        </div>
      </header>
      <div className="media-file-stage" role="group" aria-label={t('mediaViewer.playerLabel', { name })} aria-busy={view.kind === 'loading'}>
        {view.kind === 'media' && vaultId && !playbackError ? (
          <>
            {view.resource.kind === 'video' ? (
              <video
                key={view.resource.token}
                ref={(element) => { mediaRef.current = element; }}
                className="media-file-video"
                src={mediaUrl(vaultId, view.resource.token)}
                aria-label={t('mediaViewer.playerLabel', { name })}
                preload="metadata"
                playsInline
                disablePictureInPicture
                disableRemotePlayback
                onLoadedMetadata={syncMediaState}
                onDurationChange={syncMediaState}
                onTimeUpdate={syncMediaState}
                onPlay={syncMediaState}
                onPause={syncMediaState}
                onVolumeChange={syncMediaState}
                onRateChange={syncMediaState}
                onError={() => failPlayback(view.resource.token)}
              />
            ) : (
              <div className="media-file-audio-art" aria-hidden="true"><Volume2 size={40} /></div>
            )}
            {view.resource.kind === 'audio' && (
              <audio
                key={view.resource.token}
                ref={mediaRef}
                src={mediaUrl(vaultId, view.resource.token)}
                aria-label={t('mediaViewer.playerLabel', { name })}
                preload="metadata"
                onLoadedMetadata={syncMediaState}
                onDurationChange={syncMediaState}
                onTimeUpdate={syncMediaState}
                onPlay={syncMediaState}
                onPause={syncMediaState}
                onVolumeChange={syncMediaState}
                onRateChange={syncMediaState}
                onError={() => failPlayback(view.resource.token)}
              />
            )}
          </>
        ) : errorText ? (
          <div className="media-file-error" role="alert">
            <p>{errorText}</p>
            {externalError && <p>{t('mediaViewer.externalFailed')}</p>}
            {path && ((view.kind === 'error' && view.code !== 'no-vault' && view.code !== 'not-allowed' && view.code !== 'vault-changed' && view.code !== 'unavailable' && view.code !== 'file-unavailable') || playbackError) && (
              <button type="button" className="media-file-open-external" onClick={() => void openExternally()}>
                {t('mediaViewer.openExternal')}
              </button>
            )}
          </div>
        ) : (
          <p className="media-file-loading" role="status">{t('mediaViewer.loading')}</p>
        )}
      </div>
      {view.kind === 'media' && (
        <div className="media-file-controls" role="group" aria-label={t('mediaViewer.controls')}>
          <button type="button" className="icon-button small" aria-label={paused ? t('mediaViewer.play') : t('mediaViewer.pause')} disabled={playbackError} onClick={togglePlayback}>
            {paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}
          </button>
          <span className="media-file-time" aria-label={t('mediaViewer.position')}>
            {timeLabel(position, locale)} / {timeLabel(duration, locale)}
          </span>
          <label className="media-file-seek">
            <span className="media-file-sr-only">{t('mediaViewer.seek')}</span>
            <input
              type="range"
              min={0}
              max={Math.max(duration, 0)}
              step={0.1}
              value={Math.min(position, duration || 0)}
              disabled={!duration || playbackError}
              onChange={(event) => {
                const media = mediaRef.current;
                if (!media) return;
                media.currentTime = Number(event.currentTarget.value);
                syncMediaState();
              }}
            />
          </label>
          <label className="media-file-volume">
            <Volume2 size={15} aria-hidden="true" />
            <span className="media-file-sr-only">{t('mediaViewer.volume')}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              disabled={playbackError}
              onChange={(event) => {
                if (!mediaRef.current) return;
                mediaRef.current.volume = Number(event.currentTarget.value);
                syncMediaState();
              }}
            />
          </label>
          <label className="media-file-speed">
            <span className="media-file-sr-only">{t('mediaViewer.speed')}</span>
            <select
              aria-label={t('mediaViewer.speed')}
              value={playbackRate}
              disabled={playbackError}
              onChange={(event) => {
                if (!mediaRef.current) return;
                mediaRef.current.playbackRate = Number(event.currentTarget.value);
                syncMediaState();
              }}
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                <option key={rate} value={rate}>{rate}×</option>
              ))}
            </select>
          </label>
          {fullscreenError && <span className="media-file-action-error" role="status">{t('mediaViewer.fullscreenError')}</span>}
          {view.resource.kind === 'video' && (
            <button type="button" className="icon-button small" aria-label={fullscreen ? t('mediaViewer.exitFullscreen') : t('mediaViewer.fullscreen')} aria-keyshortcuts="F" title={t('mediaViewer.fullscreenKeyboard')} disabled={playbackError} onClick={() => void toggleFullscreen()}>
              {fullscreen ? <Minimize size={15} aria-hidden="true" /> : <Maximize size={15} aria-hidden="true" />}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
