import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { ToolPopupContent } from '../types';
import {
  getPreparedMarkdownImageUrl,
  prepareLocalMarkdownImages,
  resolveWorkspaceMarkdownImageSource,
} from '../../markdown/markdownImageAssets';
import { useRuntimeAssetAuth } from '../../markdown/useRuntimeAssetAuth';

interface ReadToolImageThumbnailProps {
  filePath: string;
  filename: string;
  directory: string;
  sessionId?: string;
  messageId: string;
  onShowPopup?: (content: ToolPopupContent) => void;
}

// Resolves the same way MarkdownImageGallery resolves workspace-local images
// (VS Code fs bridge vs. session-scoped server grant + authenticated asset URL).
export const ReadToolImageThumbnail: React.FC<ReadToolImageThumbnailProps> = ({
  filePath,
  filename,
  directory,
  sessionId,
  messageId,
  onShowPopup,
}) => {
  const useWorkspaceFsBridge = isVSCodeRuntime();
  const thumbnailRef = React.useRef<HTMLButtonElement>(null);
  const [shouldLoad, setShouldLoad] = React.useState(false);
  const [image, setImage] = React.useState<{ url: string; status: 'loading' | 'ready' | 'error' }>({
    url: '',
    status: 'loading',
  });
  const assetAuth = useRuntimeAssetAuth(!useWorkspaceFsBridge && shouldLoad);

  // Timeline rows are virtualized: mounting must not eagerly read every
  // referenced image ahead of the viewport (parts/DOCUMENTATION.md).
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
    if (!shouldLoad) return undefined;
    if (useWorkspaceFsBridge) {
      const controller = new AbortController();
      void resolveWorkspaceMarkdownImageSource(filePath, directory, controller.signal)
        .then((url) => {
          if (!controller.signal.aborted) setImage({ url, status: 'ready' });
        })
        .catch(() => {
          if (!controller.signal.aborted) setImage({ url: '', status: 'error' });
        });
      return () => controller.abort();
    }

    if (!sessionId || !assetAuth.ready) return undefined;
    const controller = new AbortController();
    void prepareLocalMarkdownImages({
      sources: [filePath],
      directory,
      sessionId,
      messageId,
      signal: controller.signal,
    }).then((prepared) => {
      if (controller.signal.aborted) return;
      const result = prepared.get(filePath);
      if (result?.status !== 'ready') {
        setImage({ url: '', status: 'error' });
        return;
      }
      setImage({ url: getPreparedMarkdownImageUrl(result, directory), status: 'ready' });
    }).catch(() => {
      if (!controller.signal.aborted) setImage({ url: '', status: 'error' });
    });
    return () => controller.abort();
  }, [assetAuth.nonce, assetAuth.ready, directory, filePath, messageId, sessionId, shouldLoad, useWorkspaceFsBridge]);

  const openPreview = React.useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (image.status !== 'ready' || !onShowPopup) return;
    onShowPopup({
      open: true,
      title: filename,
      content: '',
      metadata: { tool: 'image-preview', filename },
      image: { url: image.url, filename },
    });
  }, [filename, image, onShowPopup]);

  return (
    <button
      ref={thumbnailRef}
      type="button"
      onClick={openPreview}
      disabled={image.status !== 'ready'}
      className="inline-flex h-5 w-5 flex-shrink-0 items-center justify-center overflow-hidden rounded-sm border border-border/40 bg-muted/10 disabled:cursor-default"
      title={filename}
      aria-label={filename}
    >
      {image.status === 'ready' ? (
        <img
          src={image.url}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setImage({ url: '', status: 'error' })}
        />
      ) : (
        <Icon name="file-image" className="h-3.5 w-3.5 text-muted-foreground" />
      )}
    </button>
  );
};
