import React from 'react';

import { isCapacitorMobileApp } from '@/apps/mobileNativeChrome';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { shareFileFromNativeApp } from '@/lib/nativeFileShare';
import type { ToolPart } from '@/lib/opencode/model';
import { renderedPage, type RenderedPageAsk } from '@/lib/opencode/tools';
import { answerRenderedPage } from '@/lib/renderPageAnswer';
import { openExternalUrl } from '@/lib/url';
import {
    HTML_RENDER_MIN_HEIGHT,
    buildHtmlRenderDocument,
    clampHtmlRenderHeight,
    htmlRenderAnswerStateMessage,
    htmlRenderFileName,
    htmlRenderSubmitReply,
    htmlRenderTheme,
    htmlRenderThemeMessage,
    readHtmlRenderFrameMessage,
    type HtmlRenderAnswerState,
    type HtmlRenderKeyChord,
    type HtmlRenderSubmission,
    type HtmlRenderTheme,
} from './htmlRender';
import { useRenderPageHtml } from './renderPageImages';

const DEFAULT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const DEFAULT_MONO = 'ui-monospace, "SFMono-Regular", Menlo, monospace';

/** The app theme as the page's variables, following theme and interface size switches live. */
function useHtmlRenderTheme(): HtmlRenderTheme {
    const { currentTheme } = useThemeSystem();
    // The interface size setting scales the root font, and the app's
    // controls with it; read again whenever it changes.
    const interfaceSize = useUIStore((state) => state.fontSize);
    return React.useMemo(() => {
        // The user's font settings land on the root as these variables.
        const style = getComputedStyle(document.documentElement);
        return htmlRenderTheme(currentTheme, {
            rem: Number.parseFloat(style.fontSize) || 16,
            sans: style.getPropertyValue('--font-sans').trim() || DEFAULT_SANS,
            mono: style.getPropertyValue('--font-mono').trim() || DEFAULT_MONO,
        });
    }, [currentTheme, interfaceSize]);
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

const NO_ANSWER: HtmlRenderAnswerState = { waiting: false, answer: null };

interface HtmlRenderDocumentProps {
    html: string;
    title: string;
    className?: string;
    style?: React.CSSProperties;
    /** Nothing around the frame scrolls: the page's scrolling stops at its edges without bouncing. */
    contained?: boolean;
    answerState?: HtmlRenderAnswerState;
    /** Delivers what the page sent with `openchamber.submit`; rejects with the reason it was not delivered. */
    onSubmit?: (submission: HtmlRenderSubmission) => Promise<void>;
    onContentHeight?: (height: number) => void;
}

/**
 * The page in a sandboxed frame. No `allow-same-origin`: the page runs in an
 * opaque origin and cannot reach the app's storage, credentials or DOM. A
 * theme switch is posted to the page instead of rebuilding it, so whatever
 * state its script holds survives.
 */
function HtmlRenderDocument({ html, title, className, style, contained = false, answerState = NO_ANSWER, onSubmit, onContentHeight }: HtmlRenderDocumentProps) {
    const theme = useHtmlRenderTheme();
    const [initialTheme] = React.useState(theme);
    const [initialAnswerState] = React.useState(answerState);
    const srcDoc = React.useMemo(
        () => buildHtmlRenderDocument(html, initialTheme, { contained, answerState: initialAnswerState }),
        [contained, html, initialAnswerState, initialTheme],
    );
    const frameRef = React.useRef<HTMLIFrameElement>(null);

    // Theme and answer changes are posted, so whatever the page's script holds
    // (the user's half-made choice) survives them.
    const postState = React.useCallback(() => {
        // An opaque-origin page accepts messages only addressed to any origin.
        frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), '*');
        frameRef.current?.contentWindow?.postMessage(htmlRenderAnswerStateMessage(answerState), '*');
    }, [answerState, theme]);
    React.useEffect(postState, [postState]);

    const submitRef = React.useRef({ answerState, onSubmit });
    React.useLayoutEffect(() => {
        submitRef.current = { answerState, onSubmit };
    }, [answerState, onSubmit]);

    React.useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const frame = frameRef.current;
            if (!frame || event.source !== frame.contentWindow) return;
            const message = readHtmlRenderFrameMessage(event);
            if (message?.kind === 'size') onContentHeight?.(message.height);
            if (message?.kind === 'open-link') void openExternalUrl(message.url);
            if (message?.kind === 'key') replayKeyChord(frame, message.chord);
            if (message?.kind === 'submit') {
                const reply = (error?: string) => frame.contentWindow?.postMessage(htmlRenderSubmitReply(message.id, error), '*');
                const { answerState: current, onSubmit: deliver } = submitRef.current;
                if (!deliver || !current.waiting) return reply('This page is not waiting for an answer');
                // The page's own check can be skipped by the page, so the
                // gesture is checked here too: a click in the frame activates
                // this window as well, and a page that sends on its own does not.
                if (navigator.userActivation && !navigator.userActivation.isActive) return reply('openchamber.submit works only from a click');
                if (!message.submission.summary) return reply('summary is required: the choice in a few words');
                deliver(message.submission).then(() => reply(), (error) => reply(error instanceof Error ? error.message : String(error)));
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
            onLoad={postState}
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
function FullscreenPage({ html, title, initialHeight, answerState, onSubmit }: {
    html: string;
    title: string;
    initialHeight: number;
    answerState: HtmlRenderAnswerState;
    onSubmit: (submission: HtmlRenderSubmission) => Promise<void>;
}) {
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
                answerState={answerState}
                onSubmit={onSubmit}
                onContentHeight={handleContentHeight}
            />
        </div>
    );
}

/** The page an `openchamber_render` call showed, or nothing for any other part. */
export function ShownPage({ part }: { part: ToolPart }) {
    // Kept while the call's state is the same object, so the page is not sent
    // its answer state again on every render.
    const page = React.useMemo(() => renderedPage(part.tool, part.state), [part.tool, part.state]);
    return page ? <HtmlRenderFrame part={part} html={page.html} title={page.title} ask={page.ask} /> : null;
}

interface HtmlRenderFrameProps {
    part: ToolPart;
    html: string;
    title: string;
    ask: RenderedPageAsk;
}

/**
 * A page an agent showed with `openchamber_render`, inline in the reply. The
 * frame takes the height the page reports, so the page scrolls with the chat;
 * full screen and download sit in the corner.
 */
// Its own component: the blink re-renders this dot once a second, not the page around it.
function WaitingDot() {
    const blink = useWaitingBlink(true);
    return <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full bg-[var(--primary-base)]', blink)} />;
}

function HtmlRenderFrame({ part, html, title, ask }: HtmlRenderFrameProps) {
    const { t } = useI18n();
    const partId = part.id;
    const theme = useHtmlRenderTheme();
    // The page with its local images in place; null while they load, and the
    // frame keeps the page's space meanwhile.
    const loadedHtml = useRenderPageHtml(part, html);
    const pageHtml = loadedHtml ?? html;
    const [height, setHeight] = React.useState(() => rememberedHeights.get(partId) ?? HTML_RENDER_MIN_HEIGHT);
    const [fullscreen, setFullscreen] = React.useState(false);

    const handleContentHeight = React.useCallback((contentHeight: number) => {
        const next = clampHtmlRenderHeight(contentHeight);
        rememberHeight(partId, next);
        setHeight(next);
    }, [partId]);

    // On a phone the page is already as wide as the screen, so neither a
    // bigger view nor a saved file helps there. VS Code has no save route for
    // HTML, so it offers no download either.
    const isMobile = useUIStore((state) => state.isMobile);
    const canDownload = !isVSCodeRuntime();
    const handleDownload = React.useCallback(async () => {
        const fileName = htmlRenderFileName(title);
        // The saved page carries the theme it was viewed in, so it opens the
        // same way outside the app.
        const file = new File([buildHtmlRenderDocument(pageHtml, theme)], fileName, { type: 'text/html' });
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
    }, [pageHtml, t, theme, title]);

    // What this client sent, shown until the call completes with the answer
    // OpenCode stores.
    const [sent, setSent] = React.useState<HtmlRenderSubmission | null>(null);
    const answerState = React.useMemo<HtmlRenderAnswerState>(() => {
        if (ask.kind === 'answered') return { waiting: false, answer: ask.data };
        if (sent) return { waiting: false, answer: sent.data };
        return { waiting: ask.kind === 'waiting', answer: null };
    }, [ask, sent]);
    const handleSubmit = React.useCallback(async (submission: HtmlRenderSubmission) => {
        try {
            await answerRenderedPage({ sessionId: part.sessionID, callId: part.callID, ...submission });
            setSent(submission);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.htmlRender.answerFailed'), { description: message });
            throw error;
        }
    }, [part.callID, part.sessionID, t]);
    const answeredSummary = ask.kind === 'answered' ? ask.summary : sent?.summary;
    const status = answeredSummary !== undefined
        ? t('chat.htmlRender.answered', { summary: answeredSummary })
        : ask.kind === 'waiting'
            ? t('chat.htmlRender.waiting')
            : ask.kind === 'answered-in-chat'
                ? t('chat.htmlRender.answeredInChat')
                : ask.kind === 'unanswered' ? t('chat.htmlRender.unanswered') : null;
    const waiting = ask.kind === 'waiting' && answeredSummary === undefined;

    return (
        <div className="my-2">
        <div className="group/html-render relative" style={{ height }} data-html-render={partId}>
            {loadedHtml === null ? null : (
                <HtmlRenderDocument
                    html={loadedHtml}
                    title={title}
                    className="block size-full border-0 bg-transparent"
                    answerState={answerState}
                    onSubmit={handleSubmit}
                    onContentHeight={handleContentHeight}
                />
            )}
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
                            {fullscreen ? (
                                <FullscreenPage html={pageHtml} title={title} initialHeight={height} answerState={answerState} onSubmit={handleSubmit} />
                            ) : null}
                        </DialogContent>
                    </Dialog>
                </>
            )}
        </div>
        {status ? (
            <div className="mt-1 flex items-center gap-1.5 typography-meta text-muted-foreground" data-html-render-status={ask.kind}>
                {waiting ? <WaitingDot /> : null}
                <span className="min-w-0 truncate" title={status}>{status}</span>
            </div>
        ) : null}
        </div>
    );
}
