import React from 'react';
import { ComposerFloatingPanel } from '../composer/ui/ComposerFloatingPanel';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useBtwStore } from '@/stores/useBtwStore';
import { useSync } from '@/sync/use-sync';
import {
    useSessionMessageRecords,
    useSessionRenderable,
    useSessionStatus,
    useScopedBlockingPermissions,
    useScopedBlockingQuestions,
} from '@/sync/sync-context';
import { useStreamingStore } from '@/sync/streaming';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { destroyBtwSession, filterBtwTailMessages, promoteBtwSession, type BtwSessionRef } from '@/lib/btw';
import type { BtwPanelState } from './useBtwPanelState';
import { ChatSurfaceProvider } from '../ChatSurfaceContext';
import { useMobileAutocompleteMaxHeight } from '../useMobileAutocompleteMaxHeight';
import ChatMessage from '../ChatMessage';
import { PermissionCard } from '../PermissionCard';
import { QuestionCard } from '../QuestionCard';

const IDLE_SESSION_STATUS = { type: 'idle' as const };

/**
 * The `/btw` peek panel.
 *
 * Rendered from inside the composer form, so the sheet docks exactly above
 * the main composer (`absolute bottom-full` on the composer column) on both
 * desktop and mobile — the main composer IS the btw input, so nothing may
 * cover it. Identity is derived from the parent session's metadata (see
 * `useBtwPanelState`), so the panel belongs to one parent session only.
 *
 * Three exits: collapse (panel minimizes to the composer chip, the composer
 * returns to the main session), promote (the fork becomes a normal session
 * and the app navigates to it), destroy (the fork is deleted; the main
 * conversation is never touched).
 */
export const BtwPanel: React.FC<{ parentSessionId: string; panel: BtwPanelState; onExit: () => void }> = ({
    parentSessionId,
    panel,
    onExit,
}) => {
    const { t } = useI18n();
    useEscapeToExit(onExit, !panel.collapsed && Boolean(panel.pending || panel.creating || panel.btwSessionId));

    if (panel.btwSessionId && panel.btwDirectory) {
        return (
            <BtwSheet
                sessionRef={{
                    parentSessionId,
                    btwSessionId: panel.btwSessionId,
                    directory: panel.btwDirectory,
                }}
                boundaryMessageID={panel.boundaryMessageID}
                collapsed={panel.collapsed}
            />
        );
    }

    if (panel.creating) {
        return (
            <BtwFrame>
                <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    <span>{t('chat.btw.loading')}</span>
                </div>
            </BtwFrame>
        );
    }

    if (panel.pending) {
        return (
            <BtwFrame
                draftHint={t('chat.btw.draftHint')}
                collapsed={panel.collapsed}
                actions={(
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        onClick={onExit}
                        aria-label={t('chat.btw.cancelAria')}
                        title={t('chat.btw.cancelAria')}
                    >
                        <Icon name="close" className="size-4" />
                    </Button>
                )}
            />
        );
    }

    return null;
};

const useBtwDestroy = (sessionRef: BtwSessionRef | null): (() => void) => {
    const { t } = useI18n();
    return React.useCallback(() => {
        if (!sessionRef) return;
        void destroyBtwSession(sessionRef).then((ok) => {
            if (!ok) toast.error(t('chat.btw.toast.destroyFailed'));
        });
    }, [sessionRef, t]);
};

type BtwSessionData = {
    messageRecords: Array<{ info: Message; parts: Part[] }>;
    sessionIsWorking: boolean;
    streamingMessageId: string | null;
    activeStreamingPhase: 'streaming' | 'cooldown' | 'completed' | null;
    sessionPermissions: ReturnType<typeof useScopedBlockingPermissions>;
    sessionQuestions: ReturnType<typeof useScopedBlockingQuestions>;
    isEmpty: boolean;
};

/**
 * Live session data for the fork, all keyed by the fork's own ids. Only the
 * fork's tail (messages after the inherited-history boundary) is shown.
 */
const useBtwSessionData = (
    sessionId: string,
    directory: string,
    boundaryMessageID: string | null,
): BtwSessionData => {
    const sync = useSync();
    const renderable = useSessionRenderable(sessionId, directory);
    React.useEffect(() => {
        if (!renderable) {
            void sync.ensureSessionRenderable(sessionId, false, directory);
        }
    }, [directory, renderable, sessionId, sync]);

    const messageRecords = useSessionMessageRecords(sessionId, directory);
    const status = useSessionStatus(sessionId, directory) ?? IDLE_SESSION_STATUS;
    const streamingMessageId = useStreamingStore(
        React.useCallback((s) => s.streamingMessageIds.get(sessionId) ?? null, [sessionId]),
    );
    const activeStreamingPhase = useStreamingStore(
        React.useCallback(
            (s) => (streamingMessageId ? s.messageStreamStates.get(streamingMessageId)?.phase ?? null : null),
            [streamingMessageId],
        ),
    );
    const sessionPermissions = useScopedBlockingPermissions(sessionId, directory);
    const sessionQuestions = useScopedBlockingQuestions(sessionId, directory);

    const tailRecords = React.useMemo(
        () => filterBtwTailMessages(messageRecords, boundaryMessageID),
        [boundaryMessageID, messageRecords],
    );

    const sessionIsWorking = React.useMemo(() => {
        if (sessionPermissions.length > 0 || sessionQuestions.length > 0) {
            return false;
        }
        const statusType = status.type ?? 'idle';
        if (statusType === 'busy' || statusType === 'retry') {
            return true;
        }
        // SAFETY: reads only the optional `time.completed` field, which the
        // SDK Message union does not expose uniformly; a missing value means
        // the assistant turn has not completed.
        const lastMessage = tailRecords[tailRecords.length - 1]?.info as (Message & { time?: { completed?: number } }) | undefined;
        return Boolean(
            lastMessage
            && lastMessage.role === 'assistant'
            && typeof lastMessage.time?.completed !== 'number',
        );
    }, [sessionPermissions.length, sessionQuestions.length, status.type, tailRecords]);

    return {
        messageRecords: tailRecords,
        sessionIsWorking,
        streamingMessageId,
        activeStreamingPhase,
        sessionPermissions,
        sessionQuestions,
        isEmpty: tailRecords.length === 0,
    };
};

/** Composer and popup handlers get first refusal; the owner decides cancel versus collapse. */
const useEscapeToExit = (onExit: () => void, enabled: boolean): void => {
    React.useEffect(() => {
        if (!enabled) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented || isIMECompositionEvent(event)) return;
            event.preventDefault();
            onExit();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [enabled, onExit]);
};

/**
 * Stick-to-bottom auto-scroll. Streaming grows content inside one message
 * without changing the record count, so following the tail needs a
 * ResizeObserver on the content wrapper — data-driven effects alone would
 * stop following mid-stream.
 */
const useAutoScroll = (
    bodyRef: React.RefObject<HTMLDivElement | null>,
    contentRef: React.RefObject<HTMLDivElement | null>,
    contentReady: boolean,
): ((event: React.UIEvent<HTMLDivElement>) => void) => {
    const stickToBottomRef = React.useRef(true);
    // `contentReady` is a dependency because the refs are only attached once
    // the empty state gives way to the message list; an effect keyed on the
    // refs alone would run against `null` and never re-attach the observer.
    React.useEffect(() => {
        if (!contentReady) return;
        const content = contentRef.current;
        const element = bodyRef.current;
        if (element && stickToBottomRef.current) {
            element.scrollTop = element.scrollHeight;
        }
        if (!content || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(() => {
            const body = bodyRef.current;
            if (body && stickToBottomRef.current) {
                body.scrollTop = body.scrollHeight;
            }
        });
        observer.observe(content);
        return () => observer.disconnect();
    }, [bodyRef, contentReady, contentRef]);
    return React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
        const element = event.currentTarget;
        stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }, []);
};

const BtwFrame: React.FC<{
    actions?: React.ReactNode;
    onTitleClick?: () => void;
    titleClickLabel?: string;
    collapsed?: boolean;
    headerSpinner?: boolean;
    draftHint?: string;
    children?: React.ReactNode;
}> = ({ actions, onTitleClick, titleClickLabel, collapsed, headerSpinner, draftHint, children }) => (
    <ComposerFloatingPanel role="dialog" ariaLabel="btw" compact={collapsed} header={<>
            {onTitleClick ? (
                <button
                    type="button"
                    onClick={onTitleClick}
                    aria-label={titleClickLabel}
                    title={titleClickLabel}
                    className="flex min-w-0 items-center gap-2 text-left text-muted-foreground transition-colors hover:text-foreground"
                >
                    {headerSpinner ? (
                        <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin" />
                    ) : (
                        <Icon name="chat-ai-3" className="size-3.5 shrink-0" />
                    )}
                    <Icon name={collapsed ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" />
                </button>
            ) : (
                <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <Icon name="chat-ai-3" className="size-3.5 shrink-0" />
                    {draftHint ? <span className="typography-ui-label truncate">{draftHint}</span> : null}
                </span>
            )}
            <div className="min-w-0 flex-1" />
            {actions}
    </>}>
        {children ? (
            <>
                {children}
                <div className="h-2" />
            </>
        ) : null}
    </ComposerFloatingPanel>
);

const BtwSheet: React.FC<{
    sessionRef: BtwSessionRef;
    boundaryMessageID: string | null;
    collapsed: boolean;
}> = ({ sessionRef, boundaryMessageID, collapsed }) => {
    const { t } = useI18n();
    const handleDestroy = useBtwDestroy(sessionRef);
    const setCollapsed = React.useCallback((next: boolean) => {
        useBtwStore.getState().setPanelState(sessionRef.parentSessionId, { collapsed: next });
    }, [sessionRef.parentSessionId]);
    const handleToggleCollapsed = React.useCallback(() => setCollapsed(!collapsed), [collapsed, setCollapsed]);
    const handlePromote = React.useCallback(() => {
        void promoteBtwSession(sessionRef).catch(() => {
            toast.error(t('chat.btw.toast.promoteFailed'));
        });
    }, [sessionRef, t]);

    const toggleLabel = collapsed ? t('chat.btw.expandAria') : t('chat.btw.collapseAria');
    const headerButtonClass = 'size-7 rounded-lg text-muted-foreground transition-colors hover:text-foreground hover:!bg-transparent active:!bg-transparent';
    const actions = (
        <div className="flex shrink-0 items-center gap-0.5">
            <Button
                type="button"
                variant="ghost"
                size="icon"
                className={headerButtonClass}
                onClick={handlePromote}
                aria-label={t('chat.btw.promoteAria')}
                title={t('chat.btw.promoteAria')}
            >
                <Icon name="external-link" className="size-3.5" />
            </Button>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                className={headerButtonClass}
                onClick={handleDestroy}
                aria-label={t('chat.btw.destroyAria')}
                title={t('chat.btw.destroyAria')}
            >
                <Icon name="close" className="size-4" />
            </Button>
        </div>
    );

    if (collapsed) {
        return (
            <BtwCollapsedStrip
                sessionRef={sessionRef}
                actions={actions}
                onExpand={handleToggleCollapsed}
                expandLabel={toggleLabel}
            />
        );
    }

    return (
        <BtwExpandedSheet
            sessionRef={sessionRef}
            boundaryMessageID={boundaryMessageID}
            actions={actions}
            onTitleClick={handleToggleCollapsed}
            titleClickLabel={toggleLabel}
        />
    );
};

/**
 * Collapsed mode: only the header strip stays docked above the composer. The
 * fork keeps running in the background; a spinner replaces the header icon
 * while it is busy so activity stays visible without the message list.
 */
const BtwCollapsedStrip: React.FC<{
    sessionRef: BtwSessionRef;
    actions: React.ReactNode;
    onExpand: () => void;
    expandLabel: string;
}> = ({ sessionRef, actions, onExpand, expandLabel }) => {
    const status = useSessionStatus(sessionRef.btwSessionId, sessionRef.directory) ?? IDLE_SESSION_STATUS;
    const isBusy = status.type === 'busy' || status.type === 'retry';
    return (
        <BtwFrame
            actions={actions}
            onTitleClick={onExpand}
            titleClickLabel={expandLabel}
            collapsed
            headerSpinner={isBusy}
        />
    );
};

const BtwExpandedSheet: React.FC<{
    sessionRef: BtwSessionRef;
    boundaryMessageID: string | null;
    actions: React.ReactNode;
    onTitleClick: () => void;
    titleClickLabel: string;
}> = ({ sessionRef, boundaryMessageID, actions, onTitleClick, titleClickLabel }) => {
    const data = useBtwSessionData(sessionRef.btwSessionId, sessionRef.directory, boundaryMessageID);
    const bodyRef = React.useRef<HTMLDivElement | null>(null);
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    const handleBodyScroll = useAutoScroll(bodyRef, contentRef, !data.isEmpty);
    // With the on-screen keyboard open the composer (this panel's anchor)
    // rises, and a vh-based cap would push the panel under the app header.
    // Same protection as the composer autocomplete popups: clamp the scroll
    // body to the space actually available above the anchor. The hook measures
    // room for the scroll body itself, but the panel header and bottom spacer
    // sit inside the same frame above/below it — reserve their height too.
    const BTW_FRAME_CHROME_PX = 48;
    const availableMaxHeight = useMobileAutocompleteMaxHeight(bodyRef, true, 520 + BTW_FRAME_CHROME_PX);
    const mobileMaxHeight = availableMaxHeight !== undefined
        ? Math.max(120, availableMaxHeight - BTW_FRAME_CHROME_PX)
        : undefined;

    return (
        <BtwFrame actions={actions} onTitleClick={onTitleClick} titleClickLabel={titleClickLabel} collapsed={false}>
            <ChatSurfaceProvider mode="peek">
                <BtwMessages
                    data={data}
                    bodyRef={bodyRef}
                    contentRef={contentRef}
                    onBodyScroll={handleBodyScroll}
                    maxHeight={mobileMaxHeight}
                />
            </ChatSurfaceProvider>
        </BtwFrame>
    );
};

const BtwMessages: React.FC<{
    data: BtwSessionData;
    bodyRef: React.RefObject<HTMLDivElement | null>;
    contentRef: React.RefObject<HTMLDivElement | null>;
    onBodyScroll: (event: React.UIEvent<HTMLDivElement>) => void;
    maxHeight?: number;
}> = ({ data, bodyRef, contentRef, onBodyScroll, maxHeight }) => {
    const { t } = useI18n();

    if (data.isEmpty) {
        return (
            <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
                <Icon name="loader-4" className="size-4 animate-spin" />
                <span>{t('chat.btw.loading')}</span>
            </div>
        );
    }

    return (
        <ScrollShadow
            ref={bodyRef}
            onScroll={onBodyScroll}
            size={32}
            data-scroll-shadow="true"
            className="max-h-[min(55vh,520px)] min-h-0 overflow-y-auto px-3 py-1"
            style={maxHeight !== undefined ? { maxHeight } : undefined}
        >
            <div ref={contentRef}>
                {data.messageRecords.map((record, index) => (
                    <ChatMessage
                        key={record.info.id}
                        message={record}
                        previousMessage={data.messageRecords[index - 1]}
                        nextMessage={data.messageRecords[index + 1]}
                        isInActiveTurn={index === data.messageRecords.length - 1}
                        activeStreamingPhase={
                            record.info.id === data.streamingMessageId ? data.activeStreamingPhase : null
                        }
                    />
                ))}
                {data.sessionQuestions.length > 0 || data.sessionPermissions.length > 0 ? (
                    <div>
                        {data.sessionQuestions.map((question) => (
                            <QuestionCard key={question.id} question={question} />
                        ))}
                        {data.sessionPermissions.map((permission) => (
                            <PermissionCard key={permission.id} permission={permission} />
                        ))}
                    </div>
                ) : null}
                {/* Always reserve this row so the content does not shift down
                    by a line when the indicator disappears. */}
                <div
                    className={cn(
                        'flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground',
                        !data.sessionIsWorking && 'invisible',
                    )}
                    aria-hidden={!data.sessionIsWorking}
                >
                    <Icon name="loader-4" className="size-3.5 animate-spin" />
                    <span>{t('chat.btw.working')}</span>
                </div>
            </div>
        </ScrollShadow>
    );
};
