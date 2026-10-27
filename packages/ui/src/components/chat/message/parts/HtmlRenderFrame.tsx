import React from 'react';

import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { openExternalUrl } from '@/lib/url';
import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import { useConfigStore } from '@/stores/useConfigStore';
import { dispatchFrameScroll } from '@/components/chat/lib/scroll/timelineScrollIntent';
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
    buildHtmlRenderDocument,
    htmlRenderAnswerStateMessage,
    htmlRenderClearSelectionMessage,
    htmlRenderMarksMessage,
    htmlRenderPointerMessage,
    htmlRenderRevealMessage,
    htmlRenderSubmitReply,
    htmlRenderThemeMessage,
    htmlRenderUnloadMessage,
    readHtmlRenderFrameMessage,
    type HtmlRenderAnswerState,
    type HtmlRenderKeyChord,
    type HtmlRenderSubmission,
} from './htmlRender';
import { useHtmlRenderTheme } from './useHtmlRenderTheme';

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
    /** The message part that owns this HtmlView and its quotes. */
    partId: string;
    /** The trusted evaluated HtmlView identity. */
    viewId?: string;
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
export function HtmlRenderDocument({ partId, viewId, html, title, className, style, contained = false, answerState = NO_ANSWER, onSubmit, onContentHeight, frameRef: outerFrameRef }: HtmlRenderDocumentProps) {
    const theme = useHtmlRenderTheme();
    const [initialTheme] = React.useState(theme);
    const [initialAnswerState] = React.useState(answerState);
    const [nonce] = React.useState(() => crypto.randomUUID());
    const srcDoc = React.useMemo(
        () => buildHtmlRenderDocument(html, initialTheme, { contained, answerState: initialAnswerState, nonce }),
        [contained, html, initialAnswerState, initialTheme, nonce],
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
        frameRef.current?.contentWindow?.postMessage(htmlRenderAnswerStateMessage(answerState, nonce), '*');
    }, [answerState, nonce, theme]);
    React.useEffect(postState, [postState]);

    const submitRef = React.useRef({ answerState, onSubmit });
    React.useLayoutEffect(() => {
        submitRef.current = { answerState, onSubmit };
    }, [answerState, onSubmit]);
    const contentHeightRef = React.useRef(onContentHeight);
    React.useLayoutEffect(() => {
        contentHeightRef.current = onContentHeight;
    }, [onContentHeight]);

    const postMarks = React.useCallback(() => {
        frameRef.current?.contentWindow?.postMessage(htmlRenderMarksMessage(getPageMarks(partId, viewId)), '*');
    }, [partId, viewId]);
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
            viewId,
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
    }, [partId, viewId]);

    React.useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            const frame = frameRef.current;
            if (!frame || event.source !== frame.contentWindow) return;
            const message = readHtmlRenderFrameMessage(event);
            if (message?.kind === 'size') {
                setShown(true);
                contentHeightRef.current?.(message.height);
            }
            if (message?.kind === 'open-link') void openExternalUrl(message.url);
            if (message?.kind === 'key') replayKeyChord(frame, message.chord);
            if (message?.kind === 'scroll') dispatchFrameScroll(frame, message.direction);
            if (message?.kind === 'submit') {
                const reply = (error?: string) => frame.contentWindow?.postMessage(htmlRenderSubmitReply(message.id, nonce, submitRef.current.answerState, error), '*');
                const { answerState: current, onSubmit: deliver } = submitRef.current;
                if (!deliver || !current.waiting) return reply('This page is not waiting for an answer');
                if (message.submission.nonce !== nonce) return reply('This page is no longer current');
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
                const page = { partId, viewId };
                dispatchFrameSelection(frame, {
                    text: message.text,
                    rect: message.rect,
                    anchor: message.anchor ? { ...message.anchor, page } : undefined,
                    clear: handle?.clearSelection,
                });
            }
            // Escape in the page closes the menu for its selection, as it does
            // for a selection in the chat.
            if (message?.kind === 'selection-escape') handleRef.current?.clearSelection();
            if (message?.kind === 'mark-click') {
                emitPageMarkClick({
                    partId,
                    viewId,
                    markId: message.id,
                    measure: () => frameRectInApp(frame, message.rect),
                    // In the full-screen dialog the popover must render inside it to be usable.
                    portalTarget: frame.closest<HTMLElement>('[data-slot="dialog-content"]'),
                });
            }
        };
        const documentWindow = frameRef.current?.contentWindow;
        window.addEventListener('message', handleMessage);
        return () => {
            documentWindow?.postMessage(htmlRenderUnloadMessage(nonce), '*');
            window.removeEventListener('message', handleMessage);
        };
    }, [nonce, partId, viewId]);

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
 * Wraps a page with the selection menu for the text selected in it. Every page
 * owns its menu, so the page works wherever it is drawn: in its message, hoisted
 * into the live turn (outside any message body), or full screen in a dialog.
 * The menu attributes the selection to the message that owns the HtmlView.
 */
export function PageSelectionScope({
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

export function HtmlRenderToolbar({
    annotate,
    canAnnotate,
    fullscreen,
    download,
    annotationActive,
}: {
    annotate?: { label: string; pressed: boolean; onClick: () => void };
    canAnnotate: boolean;
    fullscreen: { label: string; onClick: () => void };
    download?: { label: string; onClick: () => void };
    annotationActive: boolean;
}) {
    const isMobile = useUIStore((state) => state.isMobile);
    if (isMobile) return null;
    return (
        <div className={cn(
            'flex h-6 items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100',
            annotationActive && 'opacity-100',
        )}>
            {canAnnotate && annotate ? <ToolbarTooltipButton label={annotate.label} icon="markup" pressed={annotate.pressed} onClick={annotate.onClick} /> : null}
            <ToolbarTooltipButton label={fullscreen.label} icon="fullscreen" onClick={fullscreen.onClick} />
            {download ? <ToolbarTooltipButton label={download.label} icon="download" onClick={download.onClick} /> : null}
        </div>
    );
}
