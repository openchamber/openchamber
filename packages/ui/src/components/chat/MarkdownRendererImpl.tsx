import React from 'react';
import { isInvisibleText } from '@/lib/invisibleText';
import {
  Streamdown,
  Block,
  defaultComponents,
  type BlockProps,
  type Components,
  type HighlightResult,
  type StreamdownProps,
} from 'streamdown';
import type { Pluggable } from 'unified';
import type { Part } from '@/lib/opencode/model';
import { cn } from '@/lib/utils';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { Icon } from '@/components/icon/Icon';
import { useUIStore } from '@/stores/useUIStore';
import { getMarkdownSelectionText, normalizeMarkdownCopyContent } from './markdown/selectionMarkdown';
import { cloneSelectionContent } from './markdown/selectionRange';
import { copyMarkdownToClipboard, copyTextToClipboard } from '@/lib/clipboard';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { FadeInOnReveal } from './message/FadeInOnReveal';
import type { ToolPopupContent } from './message/types';
import { getMarkdownCjk, getMarkdownProcessingOptions, markdownMath } from './markdown/streamdownPlugins';
import { remarkEmojiShortcodes } from './markdown/remarkEmojiShortcodes';
import { remarkRepositoryReferences } from './markdown/remarkRepositoryReferences';
import type { EmojiShortcodes } from '@/lib/emoji/shortcodes';
import type { RepositoryLinkContext } from '@/lib/source-control/repositoryLinks';
import { MarkdownMediaProvider, type MarkdownDocumentAssets } from './markdown/MarkdownMediaContext';
import {
  MarkdownImage,
  MarkdownPicture,
  MarkdownSource,
  MarkdownVideo,
  MarkdownParagraph,
} from './markdown/MarkdownMedia';
import {
  MarkdownPresentationContext,
  useMarkdownPresentation,
  type MermaidControls,
  type FileReferenceSource,
} from './markdown/MarkdownPresentationContext';
import { MarkdownLink, MarkdownInlineCode } from './markdown/MarkdownLink';
import { MarkdownCode } from './markdown/MarkdownCode';
import { MarkdownTable, MarkdownTableCell } from './markdown/MarkdownTable';
import { MarkdownMermaid } from './markdown/MarkdownMermaid';
import { MarkdownBlockquote } from './markdown/MarkdownBlockquote';
import { createMarkdownCodePlugin } from './markdown/streamdownCode';
import { confirmCodePaths, confirmMarkdownFile, resolveMarkdownFile } from './markdown/markdownFileReferences';
import { getMarkdownSyntaxVars } from './markdown/markdownSyntaxVars';
import { splitFrontmatter } from './markdown/frontmatter';
import { FrontmatterProperties } from './markdown/FrontmatterProperties';
import { isBareVideoUrl, markdownMediaCopySource, markdownMediaFilename } from './markdown/markdownVideo';

export type MarkdownVariant = 'assistant' | 'tool' | 'reasoning';

export interface MarkdownRendererProps {
  content: string;
  part?: Part;
  messageId: string;
  isAnimated?: boolean;
  skipFadeIn?: boolean;
  className?: string;
  isStreaming?: boolean;
  variant?: MarkdownVariant;
  onShowPopup?: (content: ToolPopupContent) => void;
  enableFileReferences?: boolean;
}

const defaultMermaidControls: MermaidControls = {
  download: true,
  copy: true,
  showPanZoomControls: true,
};

const ExportSafeImage: typeof MarkdownImage = (props) => {
  const { purpose } = useMarkdownPresentation();
  if (!purpose) return <MarkdownImage {...props} />;
  const source = props['data-oc-media-source'] ?? (typeof props.src === 'string' ? props.src : '');
  return (
    <span data-oc-media-source={markdownMediaCopySource(source) || undefined} data-oc-media-label="true">
      {props.alt || markdownMediaFilename(source)}
    </span>
  );
};

const ExportSafeVideo: typeof MarkdownVideo = (props) => {
  const { purpose } = useMarkdownPresentation();
  if (!purpose) return <MarkdownVideo {...props} />;
  const source = props['data-oc-media-source'] ?? props.src ?? '';
  return (
    <span data-oc-media-source={markdownMediaCopySource(source) || undefined} data-oc-media-label="true">
      {props.title || markdownMediaFilename(source)}
    </span>
  );
};

const ExportSafeSource: typeof MarkdownSource = (props) => {
  const { purpose } = useMarkdownPresentation();
  return purpose ? null : <MarkdownSource {...props} />;
};

const MarkdownBodyParagraph: typeof MarkdownParagraph = (props) => {
  const { purpose } = useMarkdownPresentation();
  if (purpose) {
    const children = props.node?.children.filter((child) => child.type !== 'text' || child.value.trim());
    const only = children?.length === 1 ? children[0] : undefined;
    if (only?.type === 'element' && only.tagName === 'a') {
      const href = only.properties.href;
      const label = only.children.length === 1 && only.children[0].type === 'text'
        ? only.children[0].value
        : '';
      if (typeof href === 'string' && href === label && isBareVideoUrl(href)) {
        return (
          <p>
            <span data-oc-media-source={markdownMediaCopySource(href) || undefined} data-oc-media-label="true">
              {markdownMediaFilename(href)}
            </span>
          </p>
        );
      }
    }
    return <defaultComponents.p {...props} />;
  }

  const blockCode = props.node?.children.some((child) => child.type === 'element' && child.tagName === 'code');
  if (blockCode) return <defaultComponents.p {...props} />;
  return <MarkdownParagraph {...props} />;
};

const components: Components = {
  a: MarkdownLink,
  inlineCode: MarkdownInlineCode,
  code: MarkdownCode,
  table: MarkdownTable,
  td: MarkdownTableCell,
  th: MarkdownTableCell,
  img: ExportSafeImage,
  picture: MarkdownPicture,
  source: ExportSafeSource,
  video: ExportSafeVideo,
  p: MarkdownBodyParagraph,
  strong: ({ node: _node, ...props }) => <strong {...props} />,
  li: ({ node: _node, ...props }) => <li {...props} dir="auto" />,
  blockquote: MarkdownBlockquote,
  summary: ({ node: _node, children, ...props }) => (
    <summary {...props}>
      <span data-oc-disclosure-icon="" aria-hidden="true"><Icon name="arrow-right-s" className="size-3.5" /></span>
      <span>{children}</span>
    </summary>
  ),
};
const renderers = [{ language: 'mermaid', component: MarkdownMermaid }];
const linkSafety = { enabled: false };
const remend: StreamdownProps['remend'] = { linkMode: 'text-only', singleTilde: false };
// Static mode renders the document whole and never reads the block split, but
// Streamdown still computes it, running the marked lexer over the full text.
const wholeDocument = (markdown: string) => [markdown];
// Read once, when a block mounts. The value lives in a ref the provider keeps
// for its lifetime: a context value that changed with every streamed update
// re-rendered every block of the reply on each update.
type BlockArrival = { active: boolean; firstNewIndex: number };
const BlockArrivalContext = React.createContext<React.RefObject<BlockArrival>>({ current: { active: false, firstNewIndex: 0 } });
type ArrivalStyle = React.CSSProperties & { '--oc-md-enter-delay': string };
const arrivalDelayStyle = (delay: number): ArrivalStyle => ({ '--oc-md-enter-delay': `${delay}ms` });

const MarkdownArrivalBlock = React.memo(function MarkdownArrivalBlock(props: BlockProps) {
  const arrivalRef = React.useContext(BlockArrivalContext);
  // Only a block committed while the reply streams enters with the reveal; the
  // first block and blocks present when the message mounted do not, so a full
  // initial render does not shimmer. Several blocks committed in one update
  // cascade by 55 ms each, at most four steps. The mount decision is kept
  // across stream settlement and parent updates.
  const [delay] = React.useState(() => {
    const arrival = arrivalRef.current;
    return arrival.active && props.index > 0 && props.index >= arrival.firstNewIndex
      ? Math.min(props.index - arrival.firstNewIndex, 4) * 55
      : null;
  });
  if (isInvisibleText(props.content)) return null;
  return (
    <div
      data-oc-markdown-block=""
      className={delay === null ? undefined : 'oc-md-block-enter'}
      style={delay ? arrivalDelayStyle(delay) : undefined}
    >
      <Block {...props} />
    </div>
  );
});

class MarkdownErrorBoundary extends React.Component<
  { content: string; children: React.ReactNode },
  { failed: boolean; source: string }
> {
  state = { failed: false, source: this.props.content };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: { content: string }, state: { source: string }) {
    return props.content !== state.source ? { source: props.content, failed: false } : null;
  }
  render() {
    if (this.state.failed) {
      return <div className="whitespace-pre-wrap">{this.props.content}</div>;
    }
    return this.props.children;
  }
}

function selectedCopyPayload(element: HTMLElement): { text: string; html: string | null } | null {
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;

  const containingCode = (node: Node) => (node instanceof Element ? node : node.parentElement)?.closest('pre code');
  const code = containingCode(range.startContainer);
  const codeOnly = code && code === containingCode(range.endContainer);
  if (codeOnly) {
    const full = element.ownerDocument.createRange();
    full.selectNodeContents(code);
    const source = code.closest('[data-oc-code-source]')?.getAttribute('data-oc-code-source');
    if (
      source !== null && source !== undefined
      && range.compareBoundaryPoints(Range.START_TO_START, full) <= 0
      && range.compareBoundaryPoints(Range.END_TO_END, full) >= 0
    ) {
      return { text: source, html: null };
    }
  }

  const format = codeOnly || useUIStore.getState().copyMessagesAsPlainText ? 'plain' : 'markdown';
  const text = getMarkdownSelectionText(range, format);
  if (text === null) return null;
  if (codeOnly) return { text, html: null };

  const holder = element.ownerDocument.createElement('div');
  holder.appendChild(cloneSelectionContent(range));
  normalizeMarkdownCopyContent(holder);
  return { text, html: holder.innerHTML };
}

export interface MarkdownContentProps {
  content: string;
  variant?: MarkdownVariant;
  className?: string;
  mode?: 'streaming' | 'static';
  mediaMode?: 'assistant' | 'local';
  isStreaming?: boolean;
  allowRawHtml?: boolean;
  /** GFM single-tilde strikethrough; chat content disables it to preserve prose ranges. */
  singleTilde?: boolean;
  directory?: string;
  settled?: boolean;
  sessionId?: string;
  messageId?: string;
  enableFileReferences?: boolean;
  disableLinkSafety?: boolean;
  loopbackPreview?: boolean;
  documentAssets?: MarkdownDocumentAssets;
  onShowPopup?: (content: ToolPopupContent) => void;
  mermaidControls?: MermaidControls;
  allowMermaidWheelEvents?: boolean;
  purpose?: 'copy' | 'image';
  preparedHighlights?: ReadonlyMap<string, ReadonlyMap<string, HighlightResult>>;
  onExportCode?: (source: string, language: string) => void;
  /** Item text of this repository: `#12`, `@someone` and commit ids link as its host links them. Keep the object stable. */
  repositoryLinks?: RepositoryLinkContext | null;
  /** `:tada:` reads as 🎉 with these names (`useEmojiShortcodes`); text keeps its shortcodes without them. */
  emojiShortcodes?: EmojiShortcodes | null;
}

/** Shared screen/copy/image renderer. Streamdown owns the Markdown subtree. */
export function MarkdownContent({
  content,
  variant = 'assistant',
  className,
  mode = 'static',
  mediaMode = 'local',
  isStreaming = false,
  allowRawHtml = false,
  singleTilde = true,
  directory = '',
  settled = !isStreaming,
  sessionId,
  messageId,
  enableFileReferences = true,
  disableLinkSafety,
  loopbackPreview = false,
  documentAssets,
  onShowPopup,
  mermaidControls = defaultMermaidControls,
  allowMermaidWheelEvents,
  purpose,
  preparedHighlights,
  onExportCode,
  repositoryLinks,
  emojiShortcodes,
}: MarkdownContentProps) {
  const themeSystem = useOptionalThemeSystem();
  const theme = themeSystem?.currentTheme ?? getDefaultTheme(
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const codeWrap = useUIStore((state) => state.codeBlockLineWrap);
  const tableWrap = useUIStore((state) => state.tableCellWrap);
  const container = React.useRef<HTMLDivElement>(null);
  // Null until the first commit: blocks in the first render were not committed
  // by the stream, they were already there when the message mounted.
  const committedBlockCount = React.useRef<number | null>(null);
  const arrivalActive = mode === 'streaming' && isStreaming && !purpose && committedBlockCount.current !== null;
  const firstNewIndex = committedBlockCount.current ?? 0;
  const syntaxVars = React.useMemo(() => getMarkdownSyntaxVars(theme), [theme]);
  const arrival = React.useRef<BlockArrival>({ active: false, firstNewIndex: 0 });
  // Blocks read this while they render under this commit, never later.
  arrival.current = { active: arrivalActive, firstNewIndex };

  React.useLayoutEffect(() => {
    const nativeRoot = container.current?.firstElementChild;
    committedBlockCount.current = nativeRoot?.childElementCount ?? 0;
  }, [content]);

  React.useEffect(() => {
    const element = container.current;
    if (!element || purpose) return;

    const copy = (event: ClipboardEvent) => {
      if (event.defaultPrevented || !event.clipboardData) return;
      const payload = selectedCopyPayload(element);
      if (!payload) return;
      event.preventDefault();
      event.stopPropagation();
      event.clipboardData.setData('text/plain', payload.text);
      if (payload.html) event.clipboardData.setData('text/html', payload.html);
    };

    const menuCopy = (event: Event) => {
      if (event.defaultPrevented) return;
      const payload = selectedCopyPayload(element);
      if (!payload) return;
      event.preventDefault();
      if (!payload.html) {
        void copyTextToClipboard(payload.text);
        return;
      }
      const options = useUIStore.getState().copyMessagesAsPlainText ? { plainText: payload.text } : {};
      void copyMarkdownToClipboard(payload.text, payload.html, options);
    };

    element.ownerDocument.addEventListener('copy', copy, true);
    element.ownerDocument.defaultView?.addEventListener('openchamber:copy', menuCopy);
    return () => {
      element.ownerDocument.removeEventListener('copy', copy, true);
      element.ownerDocument.defaultView?.removeEventListener('openchamber:copy', menuCopy);
    };
  }, [purpose]);

  const isVSCode = isVSCodeRuntime();
  const fileNavigation = enableFileReferences && settled && !purpose;
  const fileReferences = fileNavigation && !isMobileSurfaceRuntime();
  const confirmFile = React.useMemo(() => {
    const results = new Map<string, Promise<string | null>>();
    return (source: string, inputKind: FileReferenceSource = 'path'): Promise<string | null> => {
      if (!fileReferences || !resolveMarkdownFile(source, directory, 'probe', inputKind) || getRuntimeKey() !== runtimeKey) {
        return Promise.resolve(null);
      }
      const key = `${inputKind}:${source}`;
      const existing = results.get(key);
      if (existing) return existing;
      if (results.size >= (isVSCode ? 40 : 80)) return Promise.resolve(null);

      const request = confirmMarkdownFile(source, directory, inputKind).then(
        (path) => getRuntimeKey() === runtimeKey ? path : null,
      );
      results.set(key, request);
      return request;
    };
  }, [fileReferences, directory, runtimeKey, isVSCode]);

  const code = React.useMemo(() => {
    const resolvePaths = fileReferences && directory
      ? (source: string) => confirmCodePaths(source, directory, isVSCode ? 40 : 80, confirmFile)
      : undefined;
    return createMarkdownCodePlugin({ isVSCode, purpose, prepared: preparedHighlights, resolvePaths });
  }, [isVSCode, purpose, preparedHighlights, fileReferences, directory, confirmFile]);
  const plugins = React.useMemo(() => ({ code, math: markdownMath, cjk: getMarkdownCjk(singleTilde), renderers }), [code, singleTilde]);
  const processing = React.useMemo(() => {
    const base = getMarkdownProcessingOptions(allowRawHtml, isVSCode, singleTilde);
    const extra: Pluggable[] = [];
    if (emojiShortcodes) extra.push([remarkEmojiShortcodes, emojiShortcodes]);
    if (repositoryLinks) extra.push([remarkRepositoryReferences, repositoryLinks]);
    if (extra.length === 0) return base;
    return { ...base, remarkPlugins: [...(base.remarkPlugins ?? []), ...extra] };
  }, [allowRawHtml, emojiShortcodes, isVSCode, repositoryLinks, singleTilde]);
  const presentation = React.useMemo(() => ({
    directory,
    fileReferences,
    fileNavigation,
    loopbackPreview,
    settled,
    purpose,
    disableLinkSafety,
    theme,
    mermaidControls,
    allowMermaidWheelEvents,
    onShowPopup,
    onExportCode,
    confirmFile,
    code,
  }), [
    directory, fileReferences, fileNavigation, loopbackPreview, settled, purpose, disableLinkSafety, theme,
    mermaidControls, allowMermaidWheelEvents, onShowPopup, onExportCode, confirmFile, code,
  ]);

  let body = (
    <Streamdown
      {...processing}
      data-oc-streamdown=""
      components={components}
      plugins={plugins}
      mode={mode}
      isAnimating={isStreaming}
      BlockComponent={MarkdownArrivalBlock}
      parseMarkdownIntoBlocksFn={mode === 'static' ? wholeDocument : undefined}
      parseIncompleteMarkdown={isStreaming}
      normalizeHtmlIndentation={false}
      animated={false}
      codeBlockMaxHeight={0}
      tableMaxHeight={0}
      lineNumbers
      controls={false}
      linkSafety={linkSafety}
      remend={remend}
      data-oc-html-mode={allowRawHtml ? 'sanitize' : 'text'}
      data-oc-export-highlighted={preparedHighlights ? 'ready' : undefined}
      data-oc-directory={directory}
      data-oc-runtime={runtimeKey}
      data-oc-file-references={fileReferences ? 'enabled' : 'disabled'}
      data-code-wrap={codeWrap ? 'true' : 'false'}
      data-table-wrap={tableWrap ? 'true' : 'false'}
      className="min-w-0 space-y-0"
    >
      {content}
    </Streamdown>
  );

  if (!purpose) {
    body = (
      <MarkdownMediaProvider
        content={content}
        mode={documentAssets || allowRawHtml ? 'document' : mediaMode}
        directory={directory}
        settled={settled}
        sessionId={sessionId}
        messageId={messageId}
        documentAssets={documentAssets}
        onShowPopup={onShowPopup}
      >
        {body}
      </MarkdownMediaProvider>
    );
  }

  return (
    <div
      ref={container}
      data-markdown-content=""
      data-markdown-html={allowRawHtml ? '' : undefined}
      data-code-wrap={codeWrap ? 'true' : 'false'}
      data-table-wrap={tableWrap ? 'true' : 'false'}
      className={cn(
        'markdown-content break-words w-full min-w-0',
        {
          'markdown-tool': variant === 'tool',
          'markdown-reasoning': variant === 'reasoning',
          'leading-relaxed': variant === 'assistant',
        },
        className,
      )}
      style={syntaxVars}
    >
      <MarkdownPresentationContext.Provider value={presentation}>
        <BlockArrivalContext.Provider value={arrival}>
          <MarkdownErrorBoundary content={content}>{body}</MarkdownErrorBoundary>
        </BlockArrivalContext.Provider>
      </MarkdownPresentationContext.Provider>
    </div>
  );
}

export const MarkdownRenderer = React.memo(function MarkdownRenderer({
  content,
  part,
  messageId,
  isAnimated = true,
  skipFadeIn = false,
  className,
  isStreaming = false,
  variant = 'assistant',
  onShowPopup,
  enableFileReferences = true,
}: MarkdownRendererProps) {
  const directory = useEffectiveDirectory() ?? '';
  const settledPart = part && (part.type === 'text' || part.type === 'reasoning') && part.time?.end !== undefined
    ? part
    : undefined;
  const identity = `${messageId}:${part?.id ?? ''}`;
  const initialMode: 'streaming' | 'static' = isStreaming || (part && !settledPart) ? 'streaming' : 'static';
  const [renderMode, setRenderMode] = React.useState({ identity, mode: initialMode });
  // A live part keeps its block tree when it settles. A different part starts
  // fresh; already-completed history uses the whole-document static renderer.
  if (renderMode.identity !== identity) {
    setRenderMode({ identity, mode: initialMode });
  }
  const body = (
    <MarkdownContent
      key={identity}
      content={content}
      singleTilde={false}
      mode={renderMode.identity === identity ? renderMode.mode : initialMode}
      mediaMode={variant === 'assistant' ? 'assistant' : 'local'}
      isStreaming={isStreaming}
      variant={variant}
      className={className}
      directory={directory}
      settled={!isStreaming}
      sessionId={settledPart?.sessionID}
      messageId={messageId}
      onShowPopup={onShowPopup}
      enableFileReferences={enableFileReferences}
      loopbackPreview
    />
  );

  if (!isAnimated) return body;
  return (
    <FadeInOnReveal key={part?.id ?? messageId} skipAnimation={skipFadeIn}>
      {body}
    </FadeInOnReveal>
  );
});

export interface SimpleMarkdownRendererProps extends Omit<
  MarkdownContentProps,
  'directory' | 'mode' | 'mediaMode' | 'isStreaming' | 'settled' | 'purpose' | 'preparedHighlights' | 'onExportCode'
> {
  frontmatter?: 'hide' | 'properties';
  /** The folder links and media resolve against; the effective directory when absent. */
  directory?: string | null;
}

export const SimpleMarkdownRenderer = React.memo(function SimpleMarkdownRenderer({
  content,
  frontmatter,
  directory: ownDirectory,
  ...props
}: SimpleMarkdownRendererProps) {
  const effectiveDirectory = useEffectiveDirectory();
  const directory = ownDirectory || effectiveDirectory || '';
  const parsed = React.useMemo(
    () => frontmatter ? splitFrontmatter(content) : { frontmatter: null, body: content },
    [content, frontmatter],
  );
  return (
    <>
      {frontmatter === 'properties' && parsed.frontmatter && (
        <FrontmatterProperties frontmatter={parsed.frontmatter} />
      )}
      <MarkdownContent {...props} content={parsed.body} directory={directory} mode="static" settled />
    </>
  );
});
