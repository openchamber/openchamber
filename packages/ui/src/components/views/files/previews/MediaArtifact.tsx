import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { ContentState } from '@/components/ui/content-state';
import { useI18n } from '@/lib/i18n';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactDimensions, formatArtifactDuration, formatArtifactSize } from './artifactMeta';

// One renewal per this window: a file that fails again right after a fresh URL
// cannot be played, and retrying it would loop.
const RENEW_RETRY_WINDOW_MS = 10_000;

/**
 * Native playback with the browser's own controls. The runtime's media engine
 * decides what it can decode; a codec it lacks surfaces as the element's error,
 * and the viewer says so instead of showing a dead player.
 *
 * The player fetches byte ranges as it plays and seeks, each with the URL token
 * in `src`. A range asked for after that token expired fails, so the first
 * error asks `renewSrc` for a URL with a fresh token and resumes at the same
 * position and speed. A renewal that returns the same URL means the token was not the
 * problem.
 */
export const MediaArtifact: React.FC<{
  kind: 'audio' | 'video';
  src: string;
  renewSrc: () => Promise<string>;
  name: string;
  sizeBytes: number | null;
  download?: React.ReactNode;
}> = ({ kind, src, renewSrc, name, sizeBytes, download }) => {
  const { t } = useI18n();
  const [duration, setDuration] = React.useState<number | null>(null);
  const [dimensions, setDimensions] = React.useState<{ width: number; height: number } | null>(null);
  const [failed, setFailed] = React.useState(false);
  const lastRenewAt = React.useRef(0);
  const resume = React.useRef<{ time: number; rate: number; playing: boolean } | null>(null);

  const onLoadedMetadata = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    const media = event.currentTarget;
    setDuration(Number.isFinite(media.duration) ? media.duration : null);
    if (media instanceof HTMLVideoElement) {
      setDimensions({ width: media.videoWidth, height: media.videoHeight });
    }
    const saved = resume.current;
    if (!saved) return;
    resume.current = null;
    media.currentTime = saved.time;
    media.playbackRate = saved.rate;
    if (saved.playing) void media.play().catch(() => {});
  };

  const onError = (event: React.SyntheticEvent<HTMLMediaElement>) => {
    const now = Date.now();
    if (now - lastRenewAt.current < RENEW_RETRY_WINDOW_MS) {
      setFailed(true);
      return;
    }
    lastRenewAt.current = now;
    const media = event.currentTarget;
    resume.current = { time: media.currentTime, rate: media.playbackRate, playing: !media.paused };
    const failedSrc = src;
    renewSrc().then((renewed) => {
      if (renewed === failedSrc) setFailed(true);
    }, () => setFailed(true));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar
        items={[
          formatArtifactDuration(duration),
          formatArtifactDimensions(dimensions),
          formatArtifactSize(sizeBytes),
        ]}
      />
      {failed ? (
        <ContentState
          icon={<FileTypeIcon filePath={name} className="size-10" />}
          title={name}
          description={t('filesView.artifact.media.unplayable')}
          actions={download}
        />
      ) : kind === 'video' ? (
        <div className="flex min-h-0 flex-1 items-center justify-center bg-[var(--surface-background)] p-3">
          <video
            src={src}
            controls
            playsInline
            preload="metadata"
            title={name}
            className="max-h-full max-w-full rounded-md"
            onLoadedMetadata={onLoadedMetadata}
            onError={onError}
          />
        </div>
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
          <div className="typography-ui-label truncate text-foreground">{name}</div>
          <audio
            src={src}
            controls
            preload="metadata"
            title={name}
            className="w-full max-w-lg"
            onLoadedMetadata={onLoadedMetadata}
            onError={onError}
          />
        </div>
      )}
    </div>
  );
};
