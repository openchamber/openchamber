import React from 'react';
import { AnimatePresence } from 'motion/react';
import { ComposerFloatingPanel } from '../composer/ui/ComposerFloatingPanel';
import type { FormRequest, Message, Part } from '@/lib/opencode/model';
import { getLastConversationRecord, isIncompleteAssistantTurn } from '@/lib/opencode/model';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { PauseClock } from '@/components/ui/pause-clock';
import { useBtwStore } from '@/stores/useBtwStore';
import { useSync } from '@/sync/use-sync';
import {
    useSessionMessageRecords,
    useSessionRenderable,
    useSessionStatus,
    useScopedBlockingPermissions,
    useScopedBlockingForms,
    useRecoveredQuestions,
} from '@/sync/sync-context';
import { useStreamingStore } from '@/sync/streaming';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { destroyBtwSession, filterBtwTailMessages, promoteBtwSession, type BtwSessionRef } from '@/lib/btw';
import type { BtwPanelState } from './useBtwPanelState';
import { attachSyntheticContext } from '../lib/attachSyntheticContext';
import { readSessionNotice } from '@/lib/opencode/session-notices';
import { ChatSurfaceProvider } from '../ChatSurfaceContext';
import { ChatTranscriptDirectoryContext } from '../chatColumnSession';
import { useMobileAutocompleteMaxHeight } from '../useMobileAutocompleteMaxHeight';
import ChatMessage from '../ChatMessage';
import { PermissionCard } from '../PermissionCard';
import { FormCard } from '../FormCard';
import { useDropSettledFormDrafts } from '@/hooks/useDropSettledFormDrafts';
import { SessionErrorNotice } from '../SessionErrorNotice';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

const IDLE_SESSION_STATUS = { type: 'idle' as const };

const formCardKey = (form: FormRequest, directory: string, runtimeKey: string): string =>
    [runtimeKey, directory, form.sessionID, form.id].join('\u0000');

const BtwPanelView: React.FC<{ parentSessionId: string; panel: BtwPanelState; hidden: boolean; onExit: () => void }> = ({
    parentSessionId,
    panel,
    hidden,
    onExit,
}) => {
    const { t } = useI18n();
    useEscapeToExit(onExit, !panel.collapsed && Boolean(panel.pending || panel.creating || panel.btwSessionId));

    let stage: React.ReactNode = null;
    if (panel.btwSessionId && panel.btwDirectory) {
        stage = (
            <BtwSheet
                key="sheet"
                sessionRef={{
                    parentSessionId,
                    btwSessionId: panel.btwSessionId,
                    directory: panel.btwDirectory,
                }}
                boundaryMessageID={panel.boundaryMessageID}
                collapsed={panel.collapsed}
            />
        );
    } else if (panel.creating) {
        stage = (
            <BtwFrame key="creating">
                <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
                    <Icon name="loader-4" className="size-4 animate-spin" />
                    <span>{t('chat.btw.loading')}</span>
                </div>
            </BtwFrame>
        );
    } else if (panel.pending) {
        stage = (
            <BtwFrame
                key="pending"
                draftHint={t('chat.btw.draftHint')}
                collapsed={panel.collapsed}
                actions={(
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={onExit}
                                aria-label={t('chat.btw.cancelAria')}
                            >
                                <Icon name="close" className="size-4" />
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={6}>{t('chat.btw.cancelAria')}</TooltipContent>
                    </Tooltip>
                )}
            />
        );
    }

    return <AnimatePresence>{hidden ? null : stage}</AnimatePresence>;
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
    sessionForms: ReturnType<typeof useScopedBlockingForms>;
    sessionRecoveredQuestions: ReturnType<typeof useRecoveredQuestions>;
    isEmpty: boolean;
};

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
    const sessionForms = useScopedBlockingForms(sessionId, directory);
    const sessionRecoveredQuestions = useRecoveredQuestions(sessionId, directory);

    const tailRecords = React.useMemo(
        () => attachSyntheticContext(filterBtwTailMessages(messageRecords, boundaryMessageID).filter((record) => !readSessionNotice(record.info))),
        [boundaryMessageID, messageRecords],
    );

    const sessionIsWorking = React.useMemo(() => {
        if (sessionPermissions.length > 0 || sessionForms.length > 0) {
            return false;
        }
        const statusType = status.type ?? 'idle';
        if (statusType === 'busy' || statusType === 'retry') {
            return true;
        }
        return isIncompleteAssistantTurn(getLastConversationRecord(tailRecords)?.info);
    }, [sessionPermissions.length, sessionForms.length, status.type, tailRecords]);

    return {
        messageRecords: tailRecords,
        sessionIsWorking,
        streamingMessageId,
        activeStreamingPhase,
        sessionPermissions,
        sessionForms,
        sessionRecoveredQuestions,
        isEmpty: tailRecords.length === 0,
    };
};

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

const useAutoScroll = (
    bodyRef: React.RefObject<HTMLDivElement | null>,
    contentRef: React.RefObject<HTMLDivElement | null>,
    contentReady: boolean,
): ((event: React.UIEvent<HTMLDivElement>) => void) => {
    const stickToBottomRef = React.useRef(true);
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
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            onClick={onTitleClick}
                            aria-label={titleClickLabel}
                            className="flex min-w-0 items-center gap-2 text-start text-muted-foreground transition-colors hover:text-foreground"
                        >
                            {headerSpinner ? (
                                <Spinner className="size-3.5 shrink-0" />
                            ) : (
                                <Icon name="chat-ai-3" className="size-3.5 shrink-0" />
                            )}
                            <Icon name={collapsed ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>{titleClickLabel}</TooltipContent>
                </Tooltip>
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
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={headerButtonClass}
                        onClick={handlePromote}
                        aria-label={t('chat.btw.promoteAria')}
                    >
                        <Icon name="external-link" className="size-3.5" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{t('chat.btw.promoteAria')}</TooltipContent>
            </Tooltip>
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={headerButtonClass}
                        onClick={handleDestroy}
                        aria-label={t('chat.btw.destroyAria')}
                    >
                        <Icon name="close" className="size-4" />
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{t('chat.btw.destroyAria')}</TooltipContent>
            </Tooltip>
        </div>
    );

    return (
        <AnimatePresence propagate>
            {collapsed ? (
                <BtwCollapsedStrip
                    key="collapsed"
                    sessionRef={sessionRef}
                    actions={actions}
                    onExpand={handleToggleCollapsed}
                    expandLabel={toggleLabel}
                />
            ) : (
                <BtwExpandedSheet
                    key="expanded"
                    sessionRef={sessionRef}
                    boundaryMessageID={boundaryMessageID}
                    actions={actions}
                    onTitleClick={handleToggleCollapsed}
                    titleClickLabel={toggleLabel}
                />
            )}
        </AnimatePresence>
    );
};

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
    const BTW_FRAME_CHROME_PX = 48;
    const availableMaxHeight = useMobileAutocompleteMaxHeight(bodyRef, true, 520 + BTW_FRAME_CHROME_PX);
    const mobileMaxHeight = availableMaxHeight !== undefined
        ? Math.max(120, availableMaxHeight - BTW_FRAME_CHROME_PX)
        : undefined;

    return (
        <BtwFrame actions={actions} onTitleClick={onTitleClick} titleClickLabel={titleClickLabel} collapsed={false}>
            <ChatSurfaceProvider mode="peek">
                <ChatTranscriptDirectoryContext.Provider value={sessionRef.directory}>
                    <BtwMessages
                        sessionRef={sessionRef}
                        data={data}
                        bodyRef={bodyRef}
                        contentRef={contentRef}
                        onBodyScroll={handleBodyScroll}
                        maxHeight={mobileMaxHeight}
                    />
                </ChatTranscriptDirectoryContext.Provider>
            </ChatSurfaceProvider>
        </BtwFrame>
    );
};

const BtwMessages: React.FC<{
    sessionRef: BtwSessionRef;
    data: BtwSessionData;
    bodyRef: React.RefObject<HTMLDivElement | null>;
    contentRef: React.RefObject<HTMLDivElement | null>;
    onBodyScroll: (event: React.UIEvent<HTMLDivElement>) => void;
    maxHeight?: number;
}> = ({ sessionRef, data, bodyRef, contentRef, onBodyScroll, maxHeight }) => {
    const { t } = useI18n();
    const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
    useDropSettledFormDrafts({ sessionId: sessionRef.btwSessionId, directory: sessionRef.directory }, data.sessionForms, data.sessionRecoveredQuestions, runtimeKey);

    if (data.isEmpty) {
        return (
            <div className="flex items-center gap-2 px-4 py-4 text-sm text-muted-foreground">
                <Icon name="loader-4" className="size-4 animate-spin" />
                <span>{t('chat.btw.loading')}</span>
            </div>
        );
    }

    return (
        <ScrollableOverlay
            ref={bodyRef}
            onScroll={onBodyScroll}
            useScrollShadow
            scrollShadowSize={32}
            data-scroll-shadow="true"
            data-selection-menu-boundary="true"
            outerClassName="max-h-[min(55vh,520px)] min-h-0"
            outerStyle={maxHeight !== undefined ? { maxHeight } : undefined}
            className="px-3 py-1"
            disableHorizontal
        >
            <div ref={contentRef}>
                {data.messageRecords.map((record, index) => (
                    <ChatMessage
                        key={record.info.id}
                        message={record}
                        nextMessage={data.messageRecords[index + 1]}
                        isInActiveTurn={index === data.messageRecords.length - 1}
                        activeStreamingPhase={
                            record.info.id === data.streamingMessageId ? data.activeStreamingPhase : null
                        }
                    />
                ))}
                {data.sessionForms.length > 0 || data.sessionPermissions.length > 0 || data.sessionRecoveredQuestions.length > 0 ? (
                    <div>
                        {data.sessionForms.map((form) => (
                            <FormCard key={formCardKey(form, sessionRef.directory, runtimeKey)} form={form} keepDraft directory={sessionRef.directory} />
                        ))}
                        {data.sessionRecoveredQuestions.map((question) => (
                            <FormCard key={formCardKey(question.form, question.directory, runtimeKey)} form={question.form} recovered={question} />
                        ))}
                        {data.sessionPermissions.map((permission) => (
                            <PermissionCard key={permission.id} permission={permission} />
                        ))}
                    </div>
                ) : null}
                <SessionErrorNotice sessionId={sessionRef.btwSessionId} directory={sessionRef.directory} />
                <div
                    className={cn(
                        'flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground',
                        !data.sessionIsWorking && 'invisible',
                    )}
                    aria-hidden={!data.sessionIsWorking}
                >
                    <PauseClock paused={!data.sessionIsWorking}>
                        <Spinner className="size-3.5" />
                    </PauseClock>
                    <span>{t('chat.btw.working')}</span>
                </div>
            </div>
        </ScrollableOverlay>
    );
};

export const BtwPanel = React.memo(BtwPanelView);
