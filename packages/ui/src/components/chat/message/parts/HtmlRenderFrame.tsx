import React from 'react';

import { isCapacitorMobileApp } from '@/apps/mobileNativeChrome';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { shareFileFromNativeApp } from '@/lib/nativeFileShare';
import type { ToolPart } from '@/lib/opencode/model';
import { renderedPage } from '@/lib/opencode/tools';
import { openExternalUrl } from '@/lib/url';
import { dispatchFrameSelection } from '../frameSelection';
import {
    HTML_RENDER_MIN_HEIGHT,
    HTML_RENDER_TOUCH_MAX_HEIGHT,
    buildHtmlRenderDocument,
    clampHtmlRenderHeight,
    htmlRenderFileName,
    htmlRenderTheme,
    htmlRenderThemeMessage,
    readHtmlRenderFrameMessage,
    type HtmlRenderKeyChord,
    type HtmlRenderTheme,
} from './htmlRender';

const DEFAULT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const DEFAULT_MONO = 'ui-monospace, "SFMono-Regular", Menlo, monospace';

/** The app theme as the page's variables, following theme switches live. */
function useHtmlRenderTheme(): HtmlRenderTheme {
    const { currentTheme } = useThemeSystem();
    return React.useMemo(() => {
        // The user's font settings land on the root as these variables.
        const style = getComputedStyle(document.documentElement);
        return htmlRenderTheme(currentTheme, {
            sans: style.getPropertyValue('--font-sans').trim() || DEFAULT_SANS,
            mono: style.getPropertyValue('--font-mono').trim() || DEFAULT_MONO,
        });
    }, [currentTheme]);
}

// A timeline row unmounts when it scrolls away and mounts again when it comes
// back. The page's last height is kept per call, so it comes back at its size
// instead of growing from the minimum under the reader's scroll.
const MAX_REMEMBERED_HEIGHTS = 500;
const rememberedHeights = new Map<string, number>();
const rememberHeight = (id: string, height: number) => {
    rememberedHeights.delete(id);
    rememberedHeights.set(id, height);
    if (rememberedHeights.size > MAX_REMEMBERED_HEIGHTS) {
        const oldest = rememberedHeights.keys().next().value;
        if (oldest !== undefined) rememberedHeights.delete(oldest);
    }
};

/**
 * Replays a chord the page passed on as if it had been pressed on the frame
 * element, so the app's shortcut handling sees an ordinary key outside any
 * text field. The matching keyup follows at once: the real one fires inside
 * the page, and the app tracks held keys for its digit shortcuts.
 */
function replayKeyChord(frame: HTMLIFrameElement, chord: HtmlRenderKeyChord) {
    for (const type of ['keydown', 'keyup'] as const) {
        frame.dispatchEvent(new KeyboardEvent(type, { ...chord, bubbles: true, cancelable: true, composed: true }));
    }
}

interface HtmlRenderDocumentProps {
    html: string;
    title: string;
    className?: string;
    style?: React.CSSProperties;
    /** Nothing around the frame scrolls: the page's scrolling stops at its edges without bouncing. */
    contained?: boolean;
    onContentHeight?: (height: number) => void;
}

/**
 * The page in a sandboxed frame. No `allow-same-origin`: the page runs in an
 * opaque origin and cannot reach the app's storage, credentials or DOM. A
 * theme switch is posted to the page instead of rebuilding it, so whatever
 * state its script holds survives.
 */
function HtmlRenderDocument({ html, title, className, style, contained = false, onContentHeight }: HtmlRenderDocumentProps) {
    const theme = useHtmlRenderTheme();
    const [initialTheme] = React.useState(theme);
    const srcDoc = React.useMemo(() => buildHtmlRenderDocument(html, initialTheme, { contained }), [contained, html, initialTheme]);
    const frameRef = React.useRef<HTMLIFrameElement>(null);

    const postTheme = React.useCallback(() => {
        // An opaque-origin page accepts messages only addressed to any origin.
        frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), '*');
    }, [theme]);
    React.useEffect(postTheme, [postTheme]);

    React.useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
            const message = readHtmlRenderFrameMessage(event);
            if (message?.kind === 'size') onContentHeight?.(message.height);
            if (message?.kind === 'open-link') void openExternalUrl(message.url);
            if (message?.kind === 'key') replayKeyChord(frameRef.current, message.chord);
            if (message?.kind === 'selection') {
                // The menu follows one selection: the app's own highlight goes.
                if (message.text) window.getSelection()?.removeAllRanges();
                dispatchFrameSelection(frameRef.current, message);
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [onContentHeight]);

    return (
        <iframe
            ref={frameRef}
            title={title}
            srcDoc={srcDoc}
            sandbox="allow-scripts allow-forms"
            onLoad={postTheme}
            className={className}
            // A frame whose color scheme differs from the page's own paints an
            // opaque canvas; matching it keeps the page on the chat background.
            style={{ ...style, colorScheme: theme.appearance }}
        />
    );
}

/**
 * The page in the full-screen dialog: inset from the dialog's edges, and as
 * tall as it needs. The dialog grows with it up to the window and the page
 * scrolls inside past that, so a short page leaves no empty half-screen.
 */
function FullscreenPage({ html, title, initialHeight }: { html: string; title: string; initialHeight: number }) {
    const [height, setHeight] = React.useState(initialHeight);
    const handleContentHeight = React.useCallback((contentHeight: number) => setHeight(Math.ceil(contentHeight)), []);
    return (
        <div className="flex min-h-0 flex-col px-5 pb-5">
            <HtmlRenderDocument
                html={html}
                title={title}
                className="block min-h-0 w-full shrink border-0 bg-transparent"
                style={{ height }}
                contained
                onContentHeight={handleContentHeight}
            />
        </div>
    );
}

/** The page a completed `openchamber_render` call showed, or nothing for any other part. */
export function ShownPage({ part }: { part: ToolPart }) {
    const page = part.state.status === 'completed'
        ? renderedPage(part.tool, part.state.input, part.state.metadata)
        : null;
    return page ? <HtmlRenderFrame partId={part.id} html={page.html} title={page.title} /> : null;
}

interface HtmlRenderFrameProps {
    partId: string;
    html: string;
    title: string;
}

/**
 * A page an agent showed with `openchamber_render`, inline in the reply. The
 * frame fits the height the page reports, up to a cap past which the page
 * scrolls inside it (on a touch screen it never does: see
 * HTML_RENDER_TOUCH_MAX_HEIGHT); full screen and download sit in the corner.
 */
export function HtmlRenderFrame({ partId, html, title }: HtmlRenderFrameProps) {
    const { t } = useI18n();
    const theme = useHtmlRenderTheme();
    const [height, setHeight] = React.useState(() => rememberedHeights.get(partId) ?? HTML_RENDER_MIN_HEIGHT);
    const [fullscreen, setFullscreen] = React.useState(false);
    const [maxHeight] = React.useState(() => (
        window.matchMedia('(pointer: coarse)').matches ? HTML_RENDER_TOUCH_MAX_HEIGHT : undefined
    ));

    const handleContentHeight = React.useCallback((contentHeight: number) => {
        const next = clampHtmlRenderHeight(contentHeight, maxHeight);
        rememberHeight(partId, next);
        setHeight(next);
    }, [maxHeight, partId]);

    // On a phone the page is already as wide as the screen, so neither a
    // bigger view nor a saved file helps there. VS Code has no save route for
    // HTML, so it offers no download either.
    const isMobile = useUIStore((state) => state.isMobile);
    const canDownload = !isVSCodeRuntime();
    const handleDownload = React.useCallback(async () => {
        const fileName = htmlRenderFileName(title);
        // The saved page carries the theme it was viewed in, so it opens the
        // same way outside the app.
        const file = new File([buildHtmlRenderDocument(html, theme)], fileName, { type: 'text/html' });
        try {
            if (isCapacitorMobileApp()) {
                await shareFileFromNativeApp(file);
                return;
            }
            const url = URL.createObjectURL(file);
            const link = document.createElement('a');
            link.download = fileName;
            link.href = url;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch {
            toast.error(t('chat.htmlRender.downloadFailed'));
        }
    }, [html, t, theme, title]);

    return (
        <div className="group/html-render relative my-2" style={{ height }} data-html-render={partId}>
            <HtmlRenderDocument
                html={html}
                title={title}
                className="block size-full border-0 bg-transparent"
                onContentHeight={handleContentHeight}
            />
            {isMobile ? null : (
                <>
                    <div className="absolute end-1 top-1 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
                        <Button
                            variant="outline"
                            size="icon"
                            aria-label={t('chat.htmlRender.fullscreen')}
                            title={t('chat.htmlRender.fullscreen')}
                            onClick={() => setFullscreen(true)}
                        >
                            <Icon name="fullscreen" />
                        </Button>
                        {canDownload ? (
                            <Button
                                variant="outline"
                                size="icon"
                                aria-label={t('chat.htmlRender.download')}
                                title={t('chat.htmlRender.download')}
                                onClick={() => { void handleDownload(); }}
                            >
                                <Icon name="download" />
                            </Button>
                        ) : null}
                    </div>
                    <Dialog open={fullscreen} onOpenChange={setFullscreen}>
                        <DialogContent className="max-w-[min(72rem,100%)] gap-0 overflow-hidden bg-background p-0">
                            <DialogTitle className="truncate px-5 py-4 pe-12">{title}</DialogTitle>
                            {fullscreen ? <FullscreenPage html={html} title={title} initialHeight={height} /> : null}
                        </DialogContent>
                    </Dialog>
                </>
            )}
        </div>
    );
}
