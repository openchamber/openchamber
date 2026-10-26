import React from 'react';
import type { Element } from 'hast';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useOpenChatLink } from '../useOpenChatLink';
import { MarkdownPresentationContext } from './MarkdownPresentationContext';
import { cn } from '@/lib/utils';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { MarkdownMediaLinkContext, useMarkdownMedia } from './markdown-media-context';
import { isBareVideoUrl, isVideoSource, hasMarkdownMediaCredentials as hasCredentials, markdownMediaCopySource as copySource, markdownMediaFilename as filename } from './markdownVideo';

type NodeProps = { node?: Element; 'data-oc-media-source'?: string };
type ImageProps = React.ComponentProps<'img'> & NodeProps;
type VideoProps = React.ComponentProps<'video'> & NodeProps;
const remoteSource = (source: string) => /^(?:https?:)?\/\//i.test(source);
const incomplete = (source: string) => source === 'streamdown:incomplete-image';
const originalSource = (props: NodeProps, src?: string): string => props['data-oc-media-source'] ?? src ?? '';

type RowSize = { width: number; height: number };
type RowContext = { report: (id: string, size: RowSize | null) => void; ready: boolean };
const ImageRowContext = React.createContext<RowContext | null>(null);

// A document preview scrolls inside its own panel, and that panel clips a
// margin set on the viewport, so its media are measured against the panel.
// Only an ancestor whose content is taller than itself counts: a table that
// scrolls sideways also computes `overflow-y: auto`, and as the root it would
// put every image in it near.
const scrollParent = (element: HTMLElement): HTMLElement | null => {
  const view = element.ownerDocument.defaultView;
  for (let node = element.parentElement; node && view; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(view.getComputedStyle(node).overflowY)) return node;
  }
  return null;
};

function useNearMedia(enabled: boolean, inScroller = false) {
  const ref = React.useRef<HTMLElement | null>(null);
  const setRef = React.useCallback((node: HTMLElement | null) => { ref.current = node; }, []);
  const [near, setNear] = React.useState(false);
  React.useEffect(() => {
    if (!enabled || !ref.current) return;
    const Observer = ref.current.ownerDocument.defaultView?.IntersectionObserver;
    if (!Observer) { setNear(true); return; }
    const observer = new Observer((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setNear(true); observer.disconnect(); }
    }, inScroller ? { root: scrollParent(ref.current), rootMargin: '100% 0px' } : { rootMargin: '200px' });
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [enabled, inScroller]);
  return { ref, setRef, near: !enabled || near };
}

/** Whether a `<source media>` query holds now; follows changes such as a resize. */
function useMediaMatches(query: string | undefined): boolean {
  const subscribe = React.useCallback((onChange: () => void) => {
    if (!query) return () => {};
    const list = window.matchMedia(query);
    list.addEventListener('change', onChange);
    return () => list.removeEventListener('change', onChange);
  }, [query]);
  return React.useSyncExternalStore(
    subscribe,
    () => !query || window.matchMedia(query).matches,
    () => true,
  );
}

// Whether a document `<picture>` is near the visible part of the preview; its
// sources have no box of their own, so the picture is watched for them.
const PictureNearContext = React.createContext<boolean | null>(null);

function MediaLabel({ source, name, title, linked }: { source: string; name: string; title?: string; linked: boolean }) {
  const presentation = React.useContext(MarkdownPresentationContext);
  const media = useMarkdownMedia();
  const openChatLink = useOpenChatLink(presentation?.directory ?? media?.owner?.options.directory ?? '');
  const label = (
    <span title={title} data-oc-media-source={copySource(source)} data-oc-media-label="true" className="inline-flex items-center gap-1 align-text-bottom text-muted-foreground">
      <Icon name="file-image" className="size-3.5 shrink-0" />
      {name}
    </span>
  );
  if (!remoteSource(source) || linked || hasCredentials(source)) return label;
  return <a href={source} className="external-link" target="_blank" rel="noopener noreferrer" onClick={(event) => {
    if (presentation?.purpose || presentation?.disableLinkSafety || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    openChatLink(source);
  }}>{label}</a>;
}

type LoadedSource = {
  owner: NonNullable<ReturnType<typeof useMarkdownMedia>>['owner'];
  signal: AbortSignal;
  source: string;
  url: string;
};
function useMediaSource(source: string, active: boolean, video = false) {
  const context = useMarkdownMedia();
  const owner = context?.owner;
  const [loaded, setLoaded] = React.useState<LoadedSource | null>(null);
  const [failed, setFailed] = React.useState<LoadedSource | null>(null);
  React.useLayoutEffect(() => {
    // Activity can reveal unchanged children without rendering them first.
    // Remove a revoked document URL before that retained DOM is painted.
    if (context?.mode === 'document') {
      setLoaded((current) => current?.signal.aborted ? null : current);
    }
  }, [context?.mode]);
  React.useEffect(() => {
    if (!owner || !source || !active) return;
    const signal = owner.controller.signal;
    let cancelled = false;
    void owner.resolve(source, video).then((url) => {
      if (!cancelled && !signal.aborted) {
        setFailed(null);
        setLoaded({ owner, signal, source, url });
      }
    }, () => {
      if (!cancelled && !signal.aborted) setFailed({ owner, signal, source, url: '' });
    });
    return () => { cancelled = true; };
  }, [owner, source, active, video]);
  return {
    url: loaded && loaded.owner === owner && loaded.source === source && (context?.mode !== 'document' || !loaded.signal.aborted) && !(failed?.owner === owner && failed?.source === source) ? loaded.url : undefined,
    fail: () => { if (owner) setFailed({ owner, signal: owner.controller.signal, source, url: '' }); },
    retry: async () => {
      if (!owner) throw new Error('Missing media owner');
      const signal = owner.controller.signal;
      const url = await owner.resolve(source, video, true);
      if (!signal.aborted) {
        setFailed(null);
        setLoaded({ owner, signal, source, url });
      }
    },
  };
}

// Tailwind preflight gives images `height: auto`, which beats the height
// attribute. A numeric pair (a GitHub screenshot, 1920 x 906) becomes a ratio
// so the image scales with the column; a height alone stays that height.
const documentImageSize = (width: ImageProps['width'], height: ImageProps['height']): React.CSSProperties => {
  const h = height === undefined ? '' : String(height).trim();
  const w = width === undefined ? '' : String(width).trim();
  if (!/^\d+$/.test(h)) return {};
  return /^\d+$/.test(w) && Number(h) > 0 ? { aspectRatio: `${w}/${h}` } : { height: `${h}px` };
};

export function MarkdownImage(props: ImageProps) {
  const source = originalSource(props, props.src);
  const context = useMarkdownMedia();
  const linked = React.useContext(MarkdownMediaLinkContext);
  if (incomplete(source)) return null;
  if (!linked && isVideoSource(source, props.alt ?? '')) return <MarkdownVideo src={source} title={props.title || props.alt} node={props.node} />;
  if (!source) return context?.mode === 'document' ? <img alt={props.alt} title={props.title} width={props.width} height={props.height} /> : null;
  if (context?.mode !== 'document' && (remoteSource(source) || linked)) return <MediaLabel source={source} name={filename(source, props.alt)} title={props.title} linked={linked} />;
  return <OwnedImage {...props} source={source} />;
}

function OwnedImage({
  source,
  node: _node,
  src: _src,
  srcSet,
  alt = '',
  title,
  className,
  style,
  width,
  height,
  onLoad,
  onError,
  ...props
}: ImageProps & { source: string }) {
  const context = useMarkdownMedia();
  const linked = React.useContext(MarkdownMediaLinkContext);
  const row = React.useContext(ImageRowContext);
  const rowReport = row?.report;
  const id = React.useId();
  const name = filename(source, alt);
  const assistant = context?.mode === 'assistant';
  const documentMode = context?.mode === 'document';
  // A document image is read once it comes near the visible part of the
  // preview; inside a `<picture>` the picture is watched instead.
  const pictureNear = React.useContext(PictureNearContext);
  const { ref, setRef, near: ownNear } = useNearMedia(assistant || documentMode && pictureNear === null, documentMode);
  const near = pictureNear ?? ownNear;
  const owner = context?.owner;
  // Only assistant parts open the message gallery; tool output, reasoning and
  // user text draw a plain picture, as before.
  const gallery = assistant && Boolean(context?.onShowPopup) && !linked;
  React.useEffect(() => owner?.register(source), [owner, source]);
  const active = Boolean(context && near && (!assistant || context.settled));
  const { url, fail } = useMediaSource(source, active);
  const resolvedSet = useResolvedSrcset(srcSet, active);
  const [dimensions, setDimensions] = React.useState<{ url: string; size: RowSize } | null>(null);
  const drawn = Boolean(url && dimensions?.url === url);
  const size = dimensions && dimensions.url === url ? dimensions.size : undefined;
  React.useEffect(() => {
    rowReport?.(id, drawn && size ? size : null);
    return () => rowReport?.(id, null);
  }, [rowReport, id, drawn, size]);
  React.useEffect(() => {
    const element = ref.current;
    if (!owner || !drawn || !element || !gallery) return;
    return owner.addGallery({ source, filename: name, element, resolve: () => owner.resolve(source, false, true) });
  }, [owner, drawn, source, name, ref, gallery]);

  const image = url || documentMode ? (
    <img
      {...props}
      ref={documentMode ? setRef : undefined}
      src={url}
      srcSet={resolvedSet}
      alt={alt || name}
      title={title}
      width={width}
      height={height}
      className={cn(documentMode ? className : 'block h-auto max-h-[30rem] w-auto max-w-full object-contain', !documentMode && !drawn && 'hidden')}
      style={documentMode ? { ...style, ...documentImageSize(width, height) } : { ...style, width: row?.ready ? '100%' : style?.width }}
      data-oc-media-source={copySource(source)}
      data-oc-media-srcset={srcSet}
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onLoad={(event) => {
        const image = event.currentTarget;
        if (url && image.naturalWidth && image.naturalHeight) {
          setDimensions({ url, size: { width: image.naturalWidth, height: image.naturalHeight } });
        }
        onLoad?.(event);
      }}
      onError={(event) => {
        fail();
        onError?.(event);
      }}
    />
  ) : null;
  const ratio = size ? size.width / size.height : 1;
  const rowStyle: React.CSSProperties | undefined = row?.ready && size ? {
    flex: `${ratio} 1 0px`,
    minWidth: `${8 * ratio}rem`,
    maxWidth: `min(${size.width}px, ${30 * ratio}rem)`,
    margin: 0,
  } : undefined;
  if (documentMode) return image;
  return (
    <span
      ref={setRef}
      className={drawn ? 'inline-block max-w-[min(100%,30rem)] align-top my-1 me-1' : undefined}
      style={rowStyle}
      data-oc-media-source={copySource(source)}
    >
      {!drawn && <MediaLabel source={source} name={name} title={title} linked={linked} />}
      {url && !gallery && image}
      {url && gallery && (
        <Button
          variant="ghost"
          className={cn('block h-auto max-w-full overflow-hidden rounded-lg bg-muted/10 p-0 cursor-zoom-in', !drawn && 'hidden')}
          aria-label={name}
          data-oc-media-gallery="true"
          onClick={() => {
            const element = ref.current;
            if (element && context?.onShowPopup) {
              void owner?.openGallery(element, context.onShowPopup).catch(() => {});
            }
          }}
        >
          {image}
        </Button>
      )}
    </span>
  );
}

function useResolvedSrcset(srcSet: string | undefined, active: boolean): string | undefined {
  const context = useMarkdownMedia();
  const owner = context?.owner;
  const [loaded, setLoaded] = React.useState<{ owner: typeof owner; signal: AbortSignal; source: string; value: string } | null>(null);
  React.useLayoutEffect(() => {
    setLoaded((current) => current?.signal.aborted ? null : current);
  }, []);
  React.useEffect(() => {
    if (!srcSet || !owner || !active || context?.mode !== 'document') return;
    const signal = owner.controller.signal;
    let cancelled = false;
    const candidates = srcSet.split(',').flatMap((part) => {
      const [source, ...descriptor] = part.trim().split(/\s+/);
      return source ? [{ source, descriptor: descriptor.join(' ') }] : [];
    });
    void Promise.all(candidates.map(async ({ source, descriptor }) => {
      const url = await owner.resolve(source);
      return descriptor ? `${url} ${descriptor}` : url;
    })).then((values) => { if (!cancelled && !signal.aborted) setLoaded({ owner, signal, source: srcSet, value: values.join(', ') }); }, () => {});
    return () => { cancelled = true; };
  }, [owner, context?.mode, srcSet, active]);
  return loaded && loaded.owner === owner && !loaded.signal.aborted && loaded.source === srcSet ? loaded.value : undefined;
}

export function MarkdownPicture({ node: _node, children, ...props }: React.ComponentProps<'picture'> & NodeProps) {
  const documentMode = useMarkdownMedia()?.mode === 'document';
  const { setRef, near } = useNearMedia(documentMode, true);
  return <picture {...props} ref={setRef}><PictureNearContext.Provider value={documentMode ? near : null}>{children}</PictureNearContext.Provider></picture>;
}

export function MarkdownSource({ node: _node, srcSet, media, ...props }: React.ComponentProps<'source'> & NodeProps) {
  const context = useMarkdownMedia();
  const pictureNear = React.useContext(PictureNearContext);
  const scheme = context?.documentAssets?.colorScheme;
  const themed = scheme ? media?.replace(/\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi, (_feature, value: string) => value.toLowerCase() === scheme ? '(min-width: 0px)' : '(max-width: -1px)') : media;
  // The browser never shows a source whose media does not hold, the other
  // theme's for one, so its files are read only once it does.
  const matches = useMediaMatches(context?.mode === 'document' ? themed : undefined);
  const resolved = useResolvedSrcset(srcSet, context?.mode === 'document' && pictureNear !== false && matches);
  if (context?.mode !== 'document') return null;
  return <source {...props} srcSet={resolved} media={themed} data-oc-media-srcset={srcSet} data-oc-media-query={media} />;
}

export function MarkdownVideo(props: VideoProps) {
  const source = originalSource(props, props.src);
  const context = useMarkdownMedia();
  const owner = context?.owner;
  const linked = React.useContext(MarkdownMediaLinkContext);
  const remote = remoteSource(source);
  const { setRef, near } = useNearMedia(context?.mode === 'assistant' && !remote);
  React.useEffect(() => !remote ? owner?.register(source) : undefined, [owner, source, remote]);
  const { url, fail, retry } = useMediaSource(source, Boolean(context && !remote && !linked && (context.mode !== 'assistant' || context.settled && near)), true);
  const [recovery, setRecovery] = React.useState<{ owner: typeof owner; source: string; url?: string; failed?: boolean; ready?: string } | null>(null);
  const currentRecovery = recovery?.owner === owner && recovery?.source === source ? recovery : null;
  const playback = React.useMemo<{ lastRetry: number; resume: { time: number; playing: boolean } | null }>(() => {
    void owner;
    void source;
    return { lastRetry: 0, resume: null };
  }, [owner, source]);
  const activePlayback = React.useRef(playback);
  activePlayback.current = playback;
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const name = props.title || filename(source);
  const src = remote ? currentRecovery?.failed ? undefined : currentRecovery?.url ?? source : url;
  const showPlayer = Boolean(src && (remote || context?.mode !== 'assistant' || currentRecovery?.ready === src));
  if (!source || incomplete(source)) return null;
  if (linked) return <MediaLabel source={source} name={name} linked />;
  return <span ref={setRef} className="inline-block max-w-full align-top" data-oc-media-source={copySource(source)}>
    {!showPlayer && <MediaLabel source={source} name={name} linked={false} />}
    {src && <video ref={videoRef} src={src} title={name} controls playsInline hidden={!showPlayer} preload={remote && context?.mode !== 'document' ? 'none' : 'metadata'} className={props.className} data-oc-media-source={copySource(source)}
      onLoadedMetadata={(event) => {
        setRecovery({ owner, source, url: currentRecovery?.url, ready: src });
        const saved = playback.resume;
        if (saved) {
          event.currentTarget.currentTime = saved.time;
          if (saved.playing) void event.currentTarget.play().catch(() => {});
          playback.resume = null;
        }
        props.onLoadedMetadata?.(event);
      }} onError={(event) => {
        if (remote) {
          const resolver = getRuntimeUrlResolver();
          const candidate = new URL(source, window.location.href);
          const raw = new URL(resolver.api('/api/fs/raw'), window.location.href);
          const owned = candidate.origin === raw.origin && candidate.pathname === raw.pathname && candidate.searchParams.has('oc_url_token');
          if (!owned || Date.now() - playback.lastRetry < 10_000) { setRecovery({ owner, source, failed: true }); return; }
          playback.lastRetry = Date.now();
          playback.resume = { time: event.currentTarget.currentTime, playing: !event.currentTarget.paused };
          const signal = owner?.controller.signal;
          candidate.searchParams.delete('oc_url_token');
          void refreshRuntimeUrlAuthToken().then(() => {
            if (signal?.aborted || activePlayback.current !== playback || resolver !== getRuntimeUrlResolver()) return;
            setRecovery({ owner, source, url: resolver.authenticatedAsset('/api/fs/raw', candidate.searchParams) });
          }, () => { if (!signal?.aborted && activePlayback.current === playback) setRecovery({ owner, source, failed: true }); });
          return;
        }
        if (Date.now() - playback.lastRetry < 10_000) { fail(); return; }
        playback.lastRetry = Date.now();
        playback.resume = { time: event.currentTarget.currentTime, playing: !event.currentTarget.paused };
        const signal = owner?.controller.signal;
        void retry().then(() => {
          if (!signal?.aborted && activePlayback.current === playback) videoRef.current?.load();
        }, () => { if (!signal?.aborted && activePlayback.current === playback) fail(); });
      }} />}
  </span>;
}

export function MarkdownParagraph({ node, children, ...props }: React.ComponentProps<'p'> & NodeProps) {
  const [sizes, setSizes] = React.useState(new Map<string, RowSize>());
  const report = React.useCallback((id: string, size: RowSize | null) => {
    setSizes((previous) => {
      if (previous.get(id) === size || !size && !previous.has(id)) return previous;
      const next = new Map(previous);
      if (size) next.set(id, size); else next.delete(id);
      return next;
    });
  }, []);
  const nodes = node?.children.filter((child) => child.type !== 'text' || child.value.trim());
  const bare = nodes?.length === 1 ? nodes[0] : undefined;
  const href = bare?.type === 'element' && bare.tagName === 'a' ? bare.properties.href : undefined;
  const bareText = bare?.type === 'element' && bare.children.length === 1 && bare.children[0]?.type === 'text' ? bare.children[0].value : '';
  const count = nodes?.length ?? 0;
  const onlyImages = count > 1 && nodes?.every((child) => child.type === 'element' && child.tagName === 'img');
  // Equal-height image rows and bare clip URLs as players belong to assistant
  // text and documents respectively, as they did before the port.
  const mode = useMarkdownMedia()?.mode;
  const ready = Boolean(mode === 'assistant' && onlyImages && sizes.size === count);
  const value = React.useMemo(() => ({ report, ready }), [report, ready]);
  if (mode === 'document' && bareText && bareText === href && isBareVideoUrl(bareText)) {
    return <p {...props} data-streamdown="paragraph"><MarkdownVideo src={bareText} /></p>;
  }
  const known = [...sizes.values()];
  const ratioSum = known.reduce((sum, size) => sum + size.width / size.height, 0);
  const paragraphStyle: React.CSSProperties = { ...props.style };
  if (ready) {
    paragraphStyle.display = 'flex';
    paragraphStyle.flexWrap = 'wrap';
    paragraphStyle.alignItems = 'flex-start';
    paragraphStyle.gap = '0.5rem';
    paragraphStyle.maxWidth = `calc(min(30rem, ${Math.min(...known.map((size) => size.height))}px) * ${ratioSum} + ${(count - 1) * 0.5}rem)`;
  }
  return (
    <ImageRowContext.Provider value={value}>
      <p {...props} data-streamdown="paragraph" data-oc-media-row={ready ? 'true' : undefined} style={paragraphStyle}>
        {children}
      </p>
    </ImageRowContext.Provider>
  );
}
