import React from 'react';

import { toast } from '@/components/ui';
import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useFrameAnnotation } from '@/components/browser/useFrameAnnotation';
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
import { DeclinePageButton } from './DeclinePageButton';
import { usePageDecline } from './usePageDecline';
import { pageBlocksTurn, usePageAsk } from './usePageAsk';
import { PageAskStatus } from './PageAskStatus';
import { UiPageFrame } from './UiPageFrame';
import { SharedPageCard } from '../../sharePages/SharedPageCard';

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

function replayKeyChord(frame: HTMLIFrameElement, chord: HtmlRenderKeyChord) {
    for (const type of ['keydown', 'keyup'] as const) {
        frame.dispatchEvent(new KeyboardEvent(type, { ...chord, bubbles: true, cancelable: true, composed: true }));
    }
}

const NO_ANSWER: HtmlRenderAnswerState = { waiting: false, answer: null };
const NO_RECT = { top: 0, left: 0, width: 0, height: 0 };

interface HtmlRenderDocumentProps {
    partId: string;
    html: string;
    title: string;
    className?: string;
    style?: React.CSSProperties;
    contained?: boolean;
    answerState?: HtmlRenderAnswerState;
    onSubmit?: (submission: HtmlRenderSubmission) => Promise<void>;
    onDecline?: () => void;
    onDeclinePlaced?: (placed: boolean) => void;
    onScriptError?: (errors: string[]) => void;
    onContentHeight?: (height: number) => void;
    frameRef?: React.RefObject<HTMLIFrameElement | null>;
}

function HtmlRenderDocument({
    partId, html, title, className, style, contained = false, answerState = NO_ANSWER, onSubmit, onDecline, onDeclinePlaced, onScriptError, onContentHeight, frameRef: outerFrameRef,
}: HtmlRenderDocumentProps) {
    const { t } = useI18n();
    const theme = useHtmlRenderTheme();
    const [initialTheme] = React.useState(theme);
    const [initialAnswerState] = React.useState(answerState);
    const [declineLabel] = React.useState(() => t('chat.htmlRender.decline'));
    const srcDoc = React.useMemo(
        () => buildHtmlRenderDocument(html, initialTheme, { contained, answerState: initialAnswerState, declineLabel }),
        [contained, declineLabel, html, initialAnswerState, initialTheme],
    );
    const frameRef = React.useRef<HTMLIFrameElement>(null);
    const setFrame = React.useCallback((node: HTMLIFrameElement | null) => {
        frameRef.current = node;
        if (outerFrameRef) outerFrameRef.current = node;
    }, [outerFrameRef]);
    const handleRef = React.useRef<PageFrameHandle | null>(null);
    const loadedRef = React.useRef(false);
    const pendingRevealRef = React.useRef<ChatQuoteAnchor | null>(null);

    const postState = React.useCallback(() => {
        frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), '*');
        frameRef.current?.contentWindow?.postMessage(htmlRenderAnswerStateMessage(answerState), '*');
    }, [answerState, theme]);
    React.useEffect(postState, [postState]);

    const submitRef = React.useRef({ answerState, onSubmit, onDecline, onDeclinePlaced, onScriptError });
    React.useLayoutEffect(() => {
        submitRef.current = { answerState, onSubmit, onDecline, onDeclinePlaced, onScriptError };
    }, [answerState, onSubmit, onDecline, onDeclinePlaced, onScriptError]);

    const postMarks = React.useCallback(() => {
        frameRef.current?.contentWindow?.postMessage(htmlRenderMarksMessage(getPageMarks(partId)), '*');
    }, [partId]);
    React.useEffect(() => {
        postMarks();
        return subscribePageMarks(partId, postMarks);
    }, [partId, postMarks]);

    const pointerOverRef = React.useRef(false);
    const postPointer = React.useCallback((over: boolean) => {
        pointerOverRef.current = over;
        frameRef.current?.contentWindow?.postMessage(htmlRenderPointerMessage(over), '*');
    }, []);

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
            clearSelection: (dismiss = true) => {
                frame.contentWindow?.postMessage(htmlRenderClearSelectionMessage(), '*');
                dispatchFrameSelection(frame, { text: '', rect: NO_RECT, dismiss });
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
                if (navigator.userActivation && !navigator.userActivation.isActive) return reply('openchamber.submit works only from a click');
                if (!message.submission.summary) return reply('summary is required: the choice in a few words');
                deliver(message.submission).then(() => reply(), (error) => reply(error instanceof Error ? error.message : String(error)));
            }
            if (message?.kind === 'decline') {
                const { answerState: current, onDecline: decline } = submitRef.current;
                if (!decline || !current.waiting || (navigator.userActivation && !navigator.userActivation.isActive)) {
                    frame.contentWindow?.postMessage(htmlRenderAnswerStateMessage(current), '*');
                } else {
                    decline();
                }
            }
            if (message?.kind === 'decline-placed') submitRef.current.onDeclinePlaced?.(message.placed);
            if (message?.kind === 'script-error') submitRef.current.onScriptError?.(message.errors);
            if (message?.kind === 'selection') {
                const handle = handleRef.current;
                if (message.text || message.dismiss) {
                    window.getSelection()?.removeAllRanges();
                    if (handle) clearOtherPageSelections(handle, Boolean(message.text));
                }
                dispatchFrameSelection(frame, {
                    text: message.text,
                    rect: message.rect,
                    anchor: message.anchor ? { ...message.anchor, page: { partId } } : undefined,
                    clear: handle?.clearSelection,
                });
            }
            if (message?.kind === 'selection-escape') handleRef.current?.clearSelection();
            if (message?.kind === 'mark-click') {
                emitPageMarkClick({
                    partId,
                    markId: message.id,
                    measure: () => frameRectInApp(frame, message.rect),
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
            style={{ ...style, colorScheme: theme.appearance, opacity: shown ? undefined : 0 }}
        />
    );
}

function FullscreenPage({ partId, messageId, html, title, initialHeight, answerState, onSubmit, onDecline, decline }: {
    partId: string;
    messageId: string;
    html: string;
    title: string;
    initialHeight: number;
    answerState: HtmlRenderAnswerState;
    onSubmit: (submission: HtmlRenderSubmission) => Promise<void>;
    onDecline: () => void;
    decline: React.ReactNode;
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
                onDecline={onDecline}
                onContentHeight={handleContentHeight}
            />
            {decline ? <div className="mt-2 shrink-0">{decline}</div> : null}
        </PageSelectionScope>
    );
}

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

export function ShownPage({ part }: { part: ToolPart }) {
    const { t } = useI18n();
    const page = React.useMemo(() => renderedPage(part.tool, part.state), [part.tool, part.state]);
    const ask = usePageAsk(part, page?.ask);
    if (!page || !ask) return null;
    const plainPage = page.ui
        ? <UiPageFrame part={part} source={page.ui} ask={ask} />
        : <HtmlRenderFrame part={part} html={page.html} title={page.title || t('chat.htmlRender.untitled')} ask={ask} />;
    if (page.share) return <SharedPageCard part={part} page={{ ...page, share: page.share }} plainPage={plainPage} />;
    return plainPage;
}

interface HtmlRenderFrameProps {
    part: ToolPart;
    html: string;
    title: string;
    ask: RenderedPageAsk;
}

function HtmlRenderFrame({ part, html, title, ask }: HtmlRenderFrameProps) {
    const { t } = useI18n();
    const partId = part.id;
    const messageId = part.messageID;
    const theme = useHtmlRenderTheme();
    const loadedHtml = useRenderPageHtml(part, html);
    const pageHtml = loadedHtml ?? html;
    const [height, setHeight] = React.useState(() => rememberedHeights.get(partId) ?? HTML_RENDER_MIN_HEIGHT);
    const [fullscreen, setFullscreen] = React.useState(false);

    const frameRef = React.useRef<HTMLIFrameElement>(null);
    const directory = useEffectiveDirectory() ?? '';
    const describePage = React.useCallback((payload: BrowserAnnotationPayload): BrowserAnnotationPayload => (
        { ...payload, pageUrl: '', pageTitle: title }
    ), [title]);
    const annotation = useFrameAnnotation({
        frameRef,
        directory,
        pageKey: partId,
        intro: t('chat.htmlRender.annotate.intro'),
        describePage,
    });

    const handleContentHeight = React.useCallback((contentHeight: number) => {
        const next = clampHtmlRenderHeight(contentHeight);
        rememberHeight(partId, next);
        setHeight(next);
    }, [partId]);

    const isMobile = useUIStore((state) => state.isMobile);
    const canDownload = !isVSCodeRuntime();
    const handleDownload = React.useCallback(async () => {
        const fileName = htmlRenderFileName(title);
        const file = new File([buildHtmlRenderDocument(pageHtml, theme)], fileName, { type: 'text/html' });
        try {
            await saveFile(file);
        } catch {
            toast.error(t('chat.htmlRender.downloadFailed'));
        }
    }, [pageHtml, t, theme, title]);

    const [sent, setSent] = React.useState<HtmlRenderSubmission | null>(null);
    const [submitting, setSubmitting] = React.useState(false);
    const [decline, sendDecline] = usePageDecline(part.sessionID, part.callID);
    const answerState = React.useMemo<HtmlRenderAnswerState>(() => {
        if (ask.kind === 'answered') return { waiting: false, answer: ask.data };
        if (sent) return { waiting: false, answer: sent.data };
        return { waiting: ask.kind === 'waiting' && decline === 'idle', answer: null };
    }, [ask, sent, decline]);
    const handleSubmit = React.useCallback(async (submission: HtmlRenderSubmission) => {
        setSubmitting(true);
        try {
            await answerRenderedPage({ sessionId: part.sessionID, callId: part.callID, ...submission });
            setSent(submission);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            toast.error(t('chat.htmlRender.answerFailed'), { description: message });
            throw error;
        } finally {
            setSubmitting(false);
        }
    }, [part.callID, part.sessionID, t]);
    const answeredSummary = ask.kind === 'answered' ? ask.summary : sent?.summary;
    const [scriptErrors, setScriptErrors] = React.useState<string[] | null>(null);
    const [notDrawnReport, setNotDrawnReport] = React.useState<'idle' | 'sending' | 'sent' | 'failed'>('idle');
    const notDrawnSent = notDrawnReport === 'sent';
    const waiting = ask.kind === 'waiting' && answeredSummary === undefined && decline !== 'declined' && !notDrawnSent;
    const notDrawn = scriptErrors !== null && (waiting || notDrawnSent || ask.kind === 'not-drawn');
    const handleScriptError = React.useCallback((errors: string[]) => {
        setScriptErrors(errors);
        if (!waiting || decline !== 'idle' || notDrawnReport !== 'idle') return;
        setNotDrawnReport('sending');
        answerRenderedPage({ sessionId: part.sessionID, callId: part.callID, notDrawn: errors })
            .then(() => setNotDrawnReport('sent'), () => setNotDrawnReport('failed'));
    }, [decline, notDrawnReport, part.callID, part.sessionID, waiting]);
    const canAnnotate = !isVSCodeRuntime() && loadedHtml !== null && !notDrawn;
    const blocking = waiting && pageBlocksTurn(ask);
    const [declineInPage, setDeclineInPage] = React.useState<boolean | null>(null);
    const declineButton = waiting && declineInPage === false
        ? <DeclinePageButton onDecline={sendDecline} disabled={submitting || decline === 'sending' || notDrawnReport === 'sending'} />
        : null;
    const blockRef = React.useRef<HTMLDivElement>(null);
    React.useEffect(() => {
        if (blocking) dispatchPageWaiting(blockRef.current);
    }, [height, blocking]);

    return (
        <div ref={blockRef} className="group/html-render my-2" data-waiting-page={blocking ? partId : undefined}>
        {isMobile ? null : (
            <div className={cn(
                'flex h-6 items-center justify-end gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100',
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
                {notDrawn ? null : (
                    <ToolbarTooltipButton label={t('chat.htmlRender.fullscreen')} icon="fullscreen" onClick={() => setFullscreen(true)} />
                )}
                {canDownload ? (
                    <ToolbarTooltipButton label={t('chat.htmlRender.download')} icon="download" onClick={() => { void handleDownload(); }} />
                ) : null}
            </div>
        )}
        <PageSelectionScope messageId={messageId} partId={partId} className={cn('relative', notDrawn && 'hidden')} style={{ height }}>
            {loadedHtml === null ? null : (
                <HtmlRenderDocument
                    partId={partId}
                    html={loadedHtml}
                    title={title}
                    className="block size-full border-0 bg-transparent"
                    answerState={answerState}
                    onSubmit={handleSubmit}
                    onDecline={sendDecline}
                    onDeclinePlaced={setDeclineInPage}
                    onScriptError={handleScriptError}
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
                                    onDecline={sendDecline}
                                    decline={declineButton}
                                />
                            ) : null}
                        </DialogContent>
                    </Dialog>
                </>
            )}
        </PageSelectionScope>
        {notDrawn ? <div className="typography-meta text-[var(--status-error)]" data-html-render-not-drawn="">{t('chat.htmlRender.pageNotDrawn')}</div> : null}
        {declineButton ? <div className="mt-2">{declineButton}</div> : null}
        <PageAskStatus
            ask={notDrawnSent && ask.kind !== 'not-drawn' ? { kind: 'not-drawn' } : decline === 'declined' && ask.kind === 'waiting' ? { kind: 'declined' } : ask}
            answeredSummary={answeredSummary}
        />
        </div>
    );
}
