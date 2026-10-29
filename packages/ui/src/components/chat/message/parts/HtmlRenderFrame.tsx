import React from 'react';

import { toast } from '@/components/ui';
import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useFrameAnnotation } from '@/components/browser/useFrameAnnotation';
import { useWaitingBlink } from '@/hooks/useDurationTicker';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { BrowserAnnotationPayload } from '@/lib/browser/contract';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolPart } from '@/lib/opencode/model';
import { renderedPage, type RenderedPageAsk } from '@/lib/opencode/tools';
import { answerRenderedPage } from '@/lib/renderPageAnswer';
import { openExternalUrl } from '@/lib/url';
import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import { useConfigStore } from '@/stores/useConfigStore';
import { dispatchFrameScroll, dispatchPageWaiting } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { useChatSurfaceMode } from '@/components/chat/useChatSurfaceMode';
import { dispatchFrameSelection, frameRectInApp } from '../frameSelection';
import {
    clearOtherPageSelections,
    emitPageMarkClick,
    getPageMarks,
    registerPageFrame,
    subscribePageMarks,
    type PageFrameHandle,
} from '../pageQuoteBridge';
import { TextSelectionMenu } from '../TextSelectionMenu';
import {
    HTML_RENDER_MIN_HEIGHT,
    buildHtmlRenderDocument,
    clampHtmlRenderHeight,
    htmlRenderAnswerStateMessage,
    htmlRenderClearSelectionMessage,
    htmlRenderFileName,
    htmlRenderMarksMessage,
    htmlRenderPointerMessage,
    htmlRenderRevealMessage,
    htmlRenderSubmitReply,
    htmlRenderThemeMessage,
    readHtmlRenderFrameMessage,
    type HtmlRenderAnswerState,
    type HtmlRenderKeyChord,
    type HtmlRenderSubmission,
} from './htmlRender';
import { useRenderPageHtml } from './renderPageImages';
import { saveFile } from './saveFile';
import { useHtmlRenderTheme } from './useHtmlRenderTheme';

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
const NO_RECT = { top: 0, left: 0, width: 0, height: 0 };

interface HtmlRenderDocumentProps {
    /** The `openchamber_render` call this page belongs to: quotes taken in it are anchored to it. */
    partId: string;
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
    /** Receives the frame, for a caller that drives the page from outside (annotation). */
    frameRef?: React.RefObject<HTMLIFrameElement | null>;
}

/**
 * The page in a sandboxed frame. No `allow-same-origin`: the page runs in an
 * opaque origin and cannot reach the app's storage, credentials or DOM. A
 * theme switch is posted to the page instead of rebuilding it, so whatever
 * state its script holds survives. The page's selections, quote marks and
 * reveals pass through here to the chat (see pageQuoteBridge.ts).
 */
function HtmlRenderDocument({ partId, html, title, className, style, contained = false, answerState = NO_ANSWER, onSubmit, onContentHeight, frameRef: outerFrameRef }: HtmlRenderDocumentProps) {
    const theme = useHtmlRenderTheme();
    const [initialTheme] = React.useState(theme);
    const [initialAnswerState] = React.useState(answerState);
    const srcDoc = React.useMemo(
        () => buildHtmlRenderDocument(html, initialTheme, { contained, answerState: initialAnswerState }),
        [contained, html, initialAnswerState, initialTheme],
    );
    const frameRef = React.useRef<HTMLIFrameElement>(null);
    const setFrame = React.useCallback((node: HTMLIFrameElement | null) => {
        frameRef.current = node;
        if (outerFrameRef) outerFrameRef.current = node;
    }, [outerFrameRef]);
    const handleRef = React.useRef<PageFrameHandle | null>(null);
    // A reveal that arrives before the page has loaded waits for it.
    const loadedRef = React.useRef(false);
    const pendingRevealRef = React.useRef<ChatQuoteAnchor | null>(null);

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

    const postMarks = React.useCallback(() => {
        frameRef.current?.contentWindow?.postMessage(htmlRenderMarksMessage(getPageMarks(partId)), '*');
    }, [partId]);
    React.useEffect(() => {
        postMarks();
        return subscribePageMarks(partId, postMarks);
    }, [partId, postMarks]);

    // The page shows its horizontal scrollbar only while the pointer is over
    // it; a page loaded under the pointer learns that on load.
    const pointerOverRef = React.useRef(false);
    const postPointer = React.useCallback((over: boolean) => {
        pointerOverRef.current = over;
        frameRef.current?.contentWindow?.postMessage(htmlRenderPointerMessage(over), '*');
    }, []);

    // A page flashed white for a moment each time the timeline mounted it
    // again while scrolling: what a new frame paints before the page's own
    // document (an empty document, a frame process without its first frame)
    // is not the page, and under the app's dark theme it came out white. The
    // frame stays hidden until the page has drawn itself: its first size
    // report (sent once it is laid out, before slow images finish) or its
    // load, whichever comes first. Its space is already held at the page's
    // remembered height. A later load swaps documents without an empty one
    // in between, so the frame stays shown. Hidden by opacity: Chromium may
    // throttle the rendering of a cross-origin frame under visibility:hidden,
    // and the size report would then wait for the load.
    const [shown, setShown] = React.useState(false);
    const handleLoad = React.useCallback(() => {
        setShown(true);
        loadedRef.current = true;
        postState();
        postMarks();
        if (pointerOverRef.current) postPointer(true);
        const pending = pendingRevealRef.current;
        pendingRevealRef.current = null;
        if (pending) frameRef.current?.contentWindow?.postMessage(htmlRenderRevealMessage(pending), '*');
    }, [postMarks, postPointer, postState]);

    React.useEffect(() => {
        const frame = frameRef.current;
        if (!frame) return;
        const handle: PageFrameHandle = {
            partId,
            reveal: (anchor) => {
                frame.scrollIntoView({ block: 'center', inline: 'nearest' });
                if (loadedRef.current) {
                    frame.contentWindow?.postMessage(htmlRenderRevealMessage(anchor), '*');
                } else {
                    pendingRevealRef.current = anchor;
                }
            },
            // The page drops its own selection (which does not echo it back),
            // and the page's selection menu, told it is gone, closes.
            clearSelection: () => {
                frame.contentWindow?.postMessage(htmlRenderClearSelectionMessage(), '*');
                dispatchFrameSelection(frame, { text: '', rect: NO_RECT, dismiss: true });
            },
        };
        handleRef.current = handle;
        const unregister = registerPageFrame(handle);
        return () => {
            unregister();
            handleRef.current = null;
        };
    }, [partId]);

    React.useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const frame = frameRef.current;
            if (!frame || event.source !== frame.contentWindow) return;
            const message = readHtmlRenderFrameMessage(event);
            if (message?.kind === 'size') {
                setShown(true);
                onContentHeight?.(message.height);
            }
            if (message?.kind === 'open-link') void openExternalUrl(message.url);
            if (message?.kind === 'key') replayKeyChord(frame, message.chord);
            if (message?.kind === 'scroll') dispatchFrameScroll(frame, message.direction);
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
            if (message?.kind === 'selection') {
                const handle = handleRef.current;
                if (message.text) {
                    // The menu follows one selection: the app's own highlight
                    // goes, and so does the one in any other page.
                    window.getSelection()?.removeAllRanges();
                    if (handle) clearOtherPageSelections(handle);
                }
                dispatchFrameSelection(frame, {
                    text: message.text,
                    rect: message.rect,
                    anchor: message.anchor ? { ...message.anchor, page: { partId } } : undefined,
                    clear: handle?.clearSelection,
                });
            }
            // Escape in the page closes the menu for its selection, as it does
            // for a selection in the chat.
            if (message?.kind === 'selection-escape') handleRef.current?.clearSelection();
            if (message?.kind === 'mark-click') {
                emitPageMarkClick({
                    partId,
                    markId: message.id,
                    measure: () => frameRectInApp(frame, message.rect),
                    // In the full-screen dialog the popover must render inside it to be usable.
                    portalTarget: frame.closest<HTMLElement>('[data-slot="dialog-content"]'),
                });
            }
        };
        window.addEventListener('message', handleMessage);
        return () => window.removeEventListener('message', handleMessage);
    }, [onContentHeight, partId]);

    return (
        <iframe
            ref={setFrame}
            title={title}
            srcDoc={srcDoc}
            sandbox="allow-scripts allow-forms"
            onLoad={handleLoad}
            onPointerEnter={() => postPointer(true)}
            onPointerLeave={() => postPointer(false)}
            className={className}
            // A frame whose color scheme differs from the page's own paints an
            // opaque canvas; matching it keeps the page on the chat background.
            style={{ ...style, colorScheme: theme.appearance, opacity: shown ? undefined : 0 }}
        />
    );
}

/**
 * The page in the full-screen dialog: inset from the dialog's edges, and as
 * tall as it needs. The dialog grows with it up to the window and the page
 * scrolls inside past that, so a short page leaves no empty half-screen.
 */
function FullscreenPage({ partId, messageId, html, title, initialHeight, answerState, onSubmit }: {
    partId: string;
    messageId: string;
    html: string;
    title: string;
    initialHeight: number;
    answerState: HtmlRenderAnswerState;
    onSubmit: (submission: HtmlRenderSubmission) => Promise<void>;
}) {
    const [height, setHeight] = React.useState(initialHeight);
    const handleContentHeight = React.useCallback((contentHeight: number) => setHeight(Math.ceil(contentHeight)), []);
    return (
        <PageSelectionScope messageId={messageId} className="flex min-h-0 flex-col px-5 pb-5">
            <HtmlRenderDocument
                partId={partId}
                html={html}
                title={title}
                className="block min-h-0 w-full shrink border-0 bg-transparent"
                style={{ height }}
                contained
                answerState={answerState}
                onSubmit={onSubmit}
                onContentHeight={handleContentHeight}
            />
        </PageSelectionScope>
    );
}

/**
 * Wraps a page with the selection menu for the text selected in it. Every page
 * owns its menu, so the page works wherever it is drawn: in its message, hoisted
 * into the live turn (outside any message body), or full screen in a dialog.
 * The menu attributes the selection to `messageId`, the message that owns the
 * `openchamber_render` call.
 */
function PageSelectionScope({
    messageId,
    className,
    style,
    partId,
    children,
}: {
    messageId: string;
    className?: string;
    style?: React.CSSProperties;
    partId?: string;
    children: React.ReactNode;
}) {
    const scopeRef = React.useRef<HTMLDivElement>(null);
    const chatSurfaceMode = useChatSurfaceMode();
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    return (
        <div ref={scopeRef} className={className} style={style} data-html-render={partId}>
            {children}
            <TextSelectionMenu
                containerRef={scopeRef}
                readingKey={messageId}
                canReadAloud={chatSurfaceMode !== 'mini-chat' && showMessageTTSButtons}
                frameSelections
            />
        </div>
    );
}

/** The page an `openchamber_render` call showed, or nothing for any other part. */
export function ShownPage({ part }: { part: ToolPart }) {
    // Kept while the call's state is the same object, so the page is not sent
    // its answer state again on every render.
    const { t } = useI18n();
    const page = React.useMemo(() => renderedPage(part.tool, part.state), [part.tool, part.state]);
    return page ? <HtmlRenderFrame part={part} html={page.html} title={page.title || t('chat.htmlRender.untitled')} ask={page.ask} /> : null;
}

interface HtmlRenderFrameProps {
    /** The call; selections and quotes in the page are attributed to its message. */
    part: ToolPart;
    html: string;
    title: string;
    ask: RenderedPageAsk;
}

/**
 * A page an agent showed with `openchamber_render`, inline in the reply. The
 * frame takes the height the page reports, so the page scrolls with the chat;
 * annotation, full screen and download sit in a row above it.
 */
// Its own component: the blink re-renders this dot once a second, not the page around it.
function WaitingDot() {
    const blink = useWaitingBlink(true);
    return <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full bg-[var(--primary-base)]', blink)} />;
}

function HtmlRenderFrame({ part, html, title, ask }: HtmlRenderFrameProps) {
    const { t } = useI18n();
    const partId = part.id;
    const messageId = part.messageID;
    const theme = useHtmlRenderTheme();
    // The page with its local images in place; null while they load, and the
    // frame keeps the page's space meanwhile.
    const loadedHtml = useRenderPageHtml(part, html);
    const pageHtml = loadedHtml ?? html;
    const [height, setHeight] = React.useState(() => rememberedHeights.get(partId) ?? HTML_RENDER_MIN_HEIGHT);
    const [fullscreen, setFullscreen] = React.useState(false);

    // The browser panel's annotation, on the page in its message: the agent
    // learns which element or area the user means, with a screenshot on the
    // desktop. Like the panel, a pointer tool: phones and VS Code do not get it.
    const frameRef = React.useRef<HTMLIFrameElement>(null);
    const directory = useEffectiveDirectory() ?? '';
    const describePage = React.useCallback((payload: BrowserAnnotationPayload): BrowserAnnotationPayload => (
        // The frame's own address is about:srcdoc; the page's title is what names it in the chat.
        { ...payload, pageUrl: '', pageTitle: title }
    ), [title]);
    const annotation = useFrameAnnotation({
        frameRef,
        directory,
        pageKey: partId,
        intro: t('chat.htmlRender.annotate.intro'),
        describePage,
    });
    const canAnnotate = !isVSCodeRuntime() && loadedHtml !== null;

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
            await saveFile(file);
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
                : ask.kind === 'chat-sent-earlier'
                    ? t('chat.htmlRender.chatSentEarlier')
                    : ask.kind === 'unanswered' ? t('chat.htmlRender.unanswered') : null;
    const waiting = ask.kind === 'waiting' && answeredSummary === undefined;
    // The chat brings a page that waits for an answer into view, and again
    // as its height arrives: an off-screen frame reports its size only once
    // it is scrolled into view.
    const blockRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (waiting) dispatchPageWaiting(blockRef.current);
    }, [height, waiting]);

    return (
        <div ref={blockRef} className="group/html-render my-2" data-waiting-page={waiting ? partId : undefined}>
        {isMobile ? null : (
            // A row of its own above the page: over the page the buttons
            // covered its own controls in the top corner. The row keeps its
            // height while the buttons fade in, so hovering moves nothing.
            <div className={cn(
                'flex h-6 items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100',
                // The way out of annotation stays in view while it runs.
                annotation.isAnnotating && 'opacity-100',
            )}>
                {canAnnotate ? (
                    <ToolbarTooltipButton
                        label={t('contextPanel.browser.annotate.toggle')}
                        icon="markup"
                        pressed={annotation.isAnnotating}
                        onClick={annotation.toggle}
                    />
                ) : null}
                <ToolbarTooltipButton label={t('chat.htmlRender.fullscreen')} icon="fullscreen" onClick={() => setFullscreen(true)} />
                {canDownload ? (
                    <ToolbarTooltipButton label={t('chat.htmlRender.download')} icon="download" onClick={() => { void handleDownload(); }} />
                ) : null}
            </div>
        )}
        <PageSelectionScope messageId={messageId} partId={partId} className="relative" style={{ height }}>
            {loadedHtml === null ? null : (
                <HtmlRenderDocument
                    partId={partId}
                    html={loadedHtml}
                    title={title}
                    className="block size-full border-0 bg-transparent"
                    answerState={answerState}
                    onSubmit={handleSubmit}
                    onContentHeight={handleContentHeight}
                    frameRef={frameRef}
                />
            )}
            {isMobile ? null : (
                <>
                    <Dialog open={fullscreen} onOpenChange={setFullscreen}>
                        <DialogContent className="max-w-[min(72rem,100%)] gap-0 overflow-hidden bg-background p-0">
                            <DialogTitle className="truncate px-5 py-4 pe-12">{title}</DialogTitle>
                            {fullscreen ? (
                                <FullscreenPage
                                    partId={partId}
                                    messageId={messageId}
                                    html={pageHtml}
                                    title={title}
                                    initialHeight={height}
                                    answerState={answerState}
                                    onSubmit={handleSubmit}
                                />
                            ) : null}
                        </DialogContent>
                    </Dialog>
                </>
            )}
        </PageSelectionScope>
        {status ? (
            <div className="mt-1 flex items-center gap-1.5 typography-meta text-muted-foreground" data-html-render-status={ask.kind}>
                {waiting ? <WaitingDot /> : null}
                <span className="min-w-0 truncate" title={status}>{status}</span>
            </div>
        ) : null}
        </div>
    );
}
