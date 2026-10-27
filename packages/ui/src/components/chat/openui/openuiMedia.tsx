import React from 'react';
import { useIsStreaming } from '@openuidev/react-lang';
import { MarkdownImage } from '../markdown/MarkdownMedia';
import { MarkdownMediaProvider } from '../markdown/MarkdownMediaContext';
import { useMarkdownMedia } from '../markdown/markdown-media-context';
import type { OpenUIProps } from './openuiProps';
import { useOpenUIHost, type OpenUIOwner } from './openuiHost';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { imageOptions } from './openuiCatalog.schema';
import { isExternalHttpUrl } from '@/lib/url';
import { useOpenChatLink } from '../useOpenChatLink';
import type { ToolPopupContent } from '../message/types';
import { useUIStore } from '@/stores/useUIStore';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';

const loadPreview = () => import('../message/ToolOutputDialog').then((module) => module.default);

export function OpenUIMediaPreview({ owner, renderKey, children }: {
  owner: OpenUIOwner;
  renderKey: string;
  children: React.ReactNode;
}) {
  const [popup, setPopup] = React.useState<ToolPopupContent | null>(null);
  const previewOwned = React.useRef(false);
  const isMobile = useUIStore((state) => state.isMobile);
  const setPreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
  const close = React.useCallback(() => {
    setPopup(null);
    if (previewOwned.current) setPreviewOpen(false);
    previewOwned.current = false;
  }, [setPreviewOpen]);
  const Preview = useOnDemandComponent(popup !== null, loadPreview, close);
  const open = React.useCallback((next: ToolPopupContent) => {
    setPopup(next);
    previewOwned.current = next.open;
    setPreviewOpen(next.open);
  }, [setPreviewOpen]);
  React.useLayoutEffect(() => {
    // Portals must not survive an Activity hide or a new program source.
    setPopup(null);
    return () => {
      if (previewOwned.current) setPreviewOpen(false);
      previewOwned.current = false;
    };
  }, [renderKey, setPreviewOpen]);
  return (
    <MarkdownMediaProvider
      content={renderKey}
      mode="assistant"
      directory={owner.directory}
      sessionId={owner.sessionId}
      messageId={owner.messageId}
      settled
      onShowPopup={open}
    >
      {children}
      {popup && Preview && (
        <Preview popup={popup} isMobile={isMobile} onOpenChange={(value) => {
          if (!value) close();
        }} />
      )}
    </MarkdownMediaProvider>
  );
}

export function ChamberImage({ props }: { props: OpenUIProps['Image'] }) {
  const { host } = useOpenUIHost();
  const streaming = useIsStreaming();
  const openLink = useOpenChatLink(host.owner.directory);
  const options = imageOptions.safeParse(props.options).data;
  const permitted = !streaming
    && host.access.kind !== 'revoked'
    && host.owner.runtimeKey === getRuntimeKey()
    && host.initialMediaSources.includes(props.src ?? '');
  const image = permitted
    ? (
      <MarkdownImage
        src={props.src}
        alt={props.alt}
        presentation={options && (options.aspectRatio !== undefined || options.fit !== undefined)
          ? { aspectRatio: options.aspectRatio, fit: options.fit }
          : undefined}
      />
    )
    : (
      <span className="text-muted-foreground typography-meta" data-oc-media-source={props.src}>
        {props.alt || props.src}
      </span>
    );
  if (!options) return image;
  const source = options.source && isExternalHttpUrl(options.source) ? options.source : undefined;
  return (
    <figure className="openui-image">
      <div data-openui-image style={{ aspectRatio: options.aspectRatio }}>{image}</div>
      {(options.caption || source) && (
        <figcaption className="typography-meta text-muted-foreground">
          {options.caption}
          {source && (
            <a href={source} className="external-link block" onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.preventDefault();
              openLink(source);
            }}>{source}</a>
          )}
        </figcaption>
      )}
    </figure>
  );
}

export function ChamberImageGallery({ props }: { props: OpenUIProps['ImageGallery'] }) {
  const { host } = useOpenUIHost();
  const media = useMarkdownMedia();
  const streaming = useIsStreaming();
  const images = props.images;
  // Register the collection together before viewport-driven loading begins.
  // The owner batches these sources and enforces the same budget as Markdown.
  React.useEffect(() => {
    if (streaming || host.access.kind === 'revoked' || host.owner.runtimeKey !== getRuntimeKey()) return;
    const releases = (images ?? [])
      .filter((image) => host.initialMediaSources.includes(image.src))
      .map((image) => media?.owner.register(image.src));
    return () => {
      for (const release of releases) release?.();
    };
  }, [images, host.initialMediaSources, host.owner.runtimeKey, host.access.kind, media?.owner, streaming]);
  return (
    <div className="openui-image-gallery" data-count={Math.min(images?.length ?? 0, 5)}>
      {(images ?? []).map((image, index) => (
        <ChamberImage
          key={index}
          props={{
            alt: image.alt ?? '',
            src: image.src,
            options: { aspectRatio: 1.5, fit: 'cover', caption: image.details },
          }}
        />
      ))}
    </div>
  );
}
