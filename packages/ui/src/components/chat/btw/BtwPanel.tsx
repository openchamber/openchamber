import React from 'react';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useBtwStore } from '@/stores/useBtwStore';
import { useSync } from '@/sync/use-sync';
import {
    useSession,
    useSessionMessageRecords,
    useSessionRenderable,
    useSessionStatus,
    useScopedBlockingPermissions,
    useScopedBlockingQuestions,
} from '@/sync/sync-context';
import { useStreamingStore } from '@/sync/streaming';
import { closeBtwPanel, filterBtwTailMessages } from '@/lib/btw';
import ChatMessage from '../ChatMessage';
import { PermissionCard } from '../PermissionCard';
import { QuestionCard } from '../QuestionCard';

const IDLE_SESSION_STATUS = { type: 'idle' as const };

/** Stable no-op so ChatMessage memoization keeps working in the read-only peek. */
const NOOP_CONTENT_CHANGE = (): void => {};

/**
 * The `/btw` peek panel.
 *
 * Rendered from inside the composer form, so the sheet docks exactly above
 * the main composer (`absolute bottom-full` on the composer column) on both
 * desktop and mobile — the main composer IS the btw input, so nothing may
 * cover it. Closing destroys the temporary fork; the main conversation is
 * never touched.
 */
export const BtwPanel: React.FC = () => {
    const panel = useBtwStore((s) => s.panel);

    if (!panel.sessionId || !panel.directory) {
        return null;
    }

    return (
        <BtwSheet
            sessionId={panel.sessionId}
            directory={panel.directory}
            forkedAtMs={panel.forkedAtMs}
        />
    );
};

/** Close = destroy: the temporary fork is deleted and the sheet closes. */
const useHandleClose = (): (() => void) => {
    const { t } = useI18n();
    return React.useCallback(() => {
        closeBtwPanel(() => {
            toast.error(t('chat.btw.toast.destroyFailed'));
        });
    }, [t]);
};

const useBtwTitle = (): string => {
    const { t } = useI18n();
    const title = useBtwStore((s) => s.panel.title);
    return title?.trim() || t('chat.btw.titleFallback');
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
 * fork's tail (messages at/after the fork boundary) is shown.
 */
const useBtwSessionData = (
    sessionId: string,
    directory: string,
    forkedAtMs: number | null,
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
        () => (forkedAtMs !== null ? filterBtwTailMessages(messageRecords, forkedAtMs) : messageRecords),
        [forkedAtMs, messageRecords],
    );

    const sessionIsWorking = React.useMemo(() => {
        if (sessionPermissions.length > 0 || sessionQuestions.length > 0) {
            return false;
        }
        const statusType = status.type ?? 'idle';
        if (statusType === 'busy' || statusType === 'retry') {
            return true;
        }
        const lastMessage = tailRecords[tailRecords.length - 1]?.info as Message | undefined;
        return Boolean(
            lastMessage
            && lastMessage.role === 'assistant'
            && typeof (lastMessage as { time?: { completed?: number } }).time?.completed !== 'number',
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

/**
 * Auto-close when the fork disappears from the live store (deleted elsewhere).
 * The first undefined must not close the sheet: a freshly forked session may
 * not be indexed by SSE yet.
 */
const useAutoCloseOnDisappearance = (sessionId: string, directory: string): void => {
    const session = useSession(sessionId, directory);
    const sessionSeenRef = React.useRef(false);
    React.useEffect(() => {
        if (session) {
            sessionSeenRef.current = true;
            return;
        }
        if (sessionSeenRef.current) {
            useBtwStore.getState().closeBtw();
        }
    }, [session]);
};

/** Esc closes the sheet unless focus is in a text field. */
const useEscapeToClose = (handleClose: () => void): void => {
    React.useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            const target = event.target as HTMLElement | null;
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
                return;
            }
            handleClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [handleClose]);
};

const useAutoScroll = (
    data: BtwSessionData,
    bodyRef: React.RefObject<HTMLDivElement | null>,
): ((event: React.UIEvent<HTMLDivElement>) => void) => {
    const stickToBottomRef = React.useRef(true);
    React.useEffect(() => {
        const element = bodyRef.current;
        if (element && stickToBottomRef.current) {
            element.scrollTop = element.scrollHeight;
        }
    }, [
        bodyRef,
        data.messageRecords.length,
        data.sessionIsWorking,
        data.streamingMessageId,
        data.sessionPermissions.length,
        data.sessionQuestions.length,
    ]);
    return React.useCallback((event: React.UIEvent<HTMLDivElement>) => {
        const element = event.currentTarget;
        stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    }, []);
};

const BtwSheet: React.FC<{ sessionId: string; directory: string; forkedAtMs: number | null }> = ({
    sessionId,
    directory,
    forkedAtMs,
}) => {
    const { t } = useI18n();
    const title = useBtwTitle();
    const handleClose = useHandleClose();
    const data = useBtwSessionData(sessionId, directory, forkedAtMs);
    useAutoCloseOnDisappearance(sessionId, directory);
    useEscapeToClose(handleClose);
    const bodyRef = React.useRef<HTMLDivElement | null>(null);
    const handleBodyScroll = useAutoScroll(data, bodyRef);

    return (
        <div
            className="chat-input-column absolute bottom-full left-0 right-0 z-30 mb-3"
            role="dialog"
            aria-label="btw"
        >
            <div className="w-full overflow-hidden rounded-xl border border-border/50 bg-background shadow-lg">
                <div className="flex items-center gap-2 px-3 pt-2">
                    <Icon name="chat-ai-3" className="size-3.5 shrink-0 text-muted-foreground" />
                    <h2 className="typography-ui-label min-w-0 flex-1 truncate pb-1 font-semibold text-foreground">
                        {title}
                    </h2>
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 rounded-lg"
                        onClick={handleClose}
                        aria-label={t('chat.btw.destroyAria')}
                        title={t('chat.btw.destroyAria')}
                    >
                        <Icon name="close" className="size-4" />
                    </Button>
                </div>
                <BtwMessages data={data} bodyRef={bodyRef} onBodyScroll={handleBodyScroll} />
                <div className="h-2" />
            </div>
        </div>
    );
};

const BtwMessages: React.FC<{
    data: BtwSessionData;
    bodyRef: React.RefObject<HTMLDivElement | null>;
    onBodyScroll: (event: React.UIEvent<HTMLDivElement>) => void;
}> = ({ data, bodyRef, onBodyScroll }) => {
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
        <div ref={bodyRef} onScroll={onBodyScroll} className="max-h-[min(55vh,520px)] min-h-0 overflow-y-auto px-3 py-1">
            {data.messageRecords.map((record, index) => (
                <ChatMessage
                    key={record.info.id}
                    message={record}
                    previousMessage={data.messageRecords[index - 1]}
                    nextMessage={data.messageRecords[index + 1]}
                    onContentChange={NOOP_CONTENT_CHANGE}
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
        </div>
    );
};
