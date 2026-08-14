import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { ToolPopupContent } from './message/types';
import {
  extractMarkdownImageCandidates,
  MAX_MARKDOWN_IMAGE_COUNT,
  type MarkdownImageCandidate,
} from './markdown/markdownCore';
import { resolveMarkdownImageSource } from './markdown/markdownImageAssets';

const MarkdownImageThumbnail: React.FC<{
  candidate: MarkdownImageCandidate;
  directory: string;
  onShowPopup?: (content: ToolPopupContent) => void;
}> = ({ candidate, directory, onShowPopup }) => {
  const thumbnailRef = React.useRef<HTMLButtonElement>(null);
  const [shouldLoad, setShouldLoad] = React.useState(false);
  const [image, setImage] = React.useState<{
    url: string;
    status: 'loading' | 'ready' | 'error';
  }>({ url: '', status: 'loading' });

  React.useEffect(() => {
    const thumbnail = thumbnailRef.current;
    if (!thumbnail || shouldLoad) return;
    if (typeof IntersectionObserver === 'undefined') {
      setShouldLoad(true);
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      setShouldLoad(true);
      observer.disconnect();
    }, { rootMargin: '200px' });
    observer.observe(thumbnail);
    return () => observer.disconnect();
  }, [shouldLoad]);

  React.useEffect(() => {
    if (!shouldLoad) return;
    const controller = new AbortController();
    setImage({ url: '', status: 'loading' });
    void resolveMarkdownImageSource(candidate.source, directory, controller.signal)
      .then((url) => {
        if (!controller.signal.aborted) setImage({ url, status: 'loading' });
      })
      .catch(() => {
        if (!controller.signal.aborted) setImage({ url: '', status: 'error' });
      });
    return () => controller.abort();
  }, [candidate.source, directory, shouldLoad]);

  const openPreview = React.useCallback(() => {
    if (image.status !== 'ready' || !onShowPopup) return;
    onShowPopup({
      open: true,
      title: candidate.filename,
      content: '',
      metadata: { tool: 'markdown-image-preview', filename: candidate.filename },
      image: { url: image.url, filename: candidate.filename },
    });
  }, [candidate.filename, image, onShowPopup]);

  return (
    <button
      ref={thumbnailRef}
      type="button"
      className="w-[100px] shrink-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
      aria-label={candidate.filename}
      disabled={image.status !== 'ready'}
      onClick={openPreview}
      data-openchamber-markdown-image-action="true"
      data-openchamber-markdown-image-source={candidate.source}
      data-openchamber-markdown-image-filename={candidate.filename}
    >
      <span className="flex h-[72px] w-[100px] items-center justify-center overflow-hidden rounded-lg border border-border/40 bg-muted/10">
        {image.url && image.status !== 'error' ? (
          <img
            src={image.url}
            alt={candidate.filename}
            className="h-full w-full object-contain"
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => setImage((current) => ({ ...current, status: 'ready' }))}
            onError={() => setImage({ url: '', status: 'error' })}
            data-openchamber-markdown-image="true"
            data-openchamber-markdown-image-thumbnail="true"
            data-openchamber-markdown-image-state={image.status}
          />
        ) : (
          <Icon name="file-image" className="h-5 w-5 text-muted-foreground" />
        )}
      </span>
      <span
        className="mt-1 flex w-[100px] items-center justify-center gap-1 text-muted-foreground"
        title={candidate.filename}
        data-openchamber-markdown-image-caption="true"
      >
        <Icon name="file-image" className="h-3 w-3 shrink-0" />
        <span className="min-w-0 truncate typography-meta">{candidate.filename}</span>
      </span>
    </button>
  );
};

export const MarkdownImageGallery: React.FC<{
  contents: readonly string[];
  onShowPopup?: (content: ToolPopupContent) => void;
}> = ({ contents, onShowPopup }) => {
  const directory = useEffectiveDirectory() ?? '';
  const candidates = React.useMemo(
    () => extractMarkdownImageCandidates(contents, MAX_MARKDOWN_IMAGE_COUNT),
    [contents],
  );

  if (candidates.length === 0) return null;

  return (
    <div
      className="mt-3 flex max-w-full gap-2 overflow-x-auto pb-1"
      data-openchamber-markdown-image-gallery="true"
    >
      {candidates.map((candidate) => (
        <MarkdownImageThumbnail
          key={candidate.source}
          candidate={candidate}
          directory={directory}
          onShowPopup={onShowPopup}
        />
      ))}
    </div>
  );
};
