/**
 * The reverted-messages dock.
 *
 * After a revert the messages that were undone are not thrown away: they stay
 * listed here so the user can put one back, or fork a new session from it.
 * Restoring the newest reverted message is an un-revert of everything, which
 * is why it routes through handleSlashRedo rather than reverting forward.
 */

import React from 'react';
import type { Part } from '@opencode-ai/sdk/v2/client';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { isSyntheticPart } from '@/lib/messages/synthetic';
import { cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync } from '@/sync/sync-context';
import {
    EMPTY_REVERTED_MESSAGE_DOCK_STATE,
    buildRevertedMessageDockState,
    type RevertedMessageDockState,
} from '../../revertedMessageDockState';

/**
 * A one-line preview of a reverted message: its text parts joined and
 * collapsed to a single line, falling back to an attached filename and then to
 * a caller-supplied placeholder.
 */
const getRevertedPreview = (parts: Part[], fallback: string): string => {
    const text = parts
        .filter((part) => part.type === 'text' && !isSyntheticPart(part))
        .map((part) => {
            const record = part as Record<string, unknown>;
            return typeof record.text === 'string'
                ? record.text
                : typeof record.content === 'string'
                    ? record.content
                    : '';
        })
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();

    if (text) return text;
    const filePart = parts.find((part) => part.type === 'file') as (Part & { filename?: string }) | undefined;
    return filePart?.filename ? `[${filePart.filename}]` : fallback;
};

type RevertedMessageDockProps = {
    sessionId: string | null;
    directory?: string;
};

export const RevertedMessageDock: React.FC<RevertedMessageDockProps> = React.memo(({ sessionId, directory }) => {
    const { t } = useI18n();
    const revertToMessage = useSessionUIStore((s) => s.revertToMessage);
    const forkFromMessage = useSessionUIStore((s) => s.forkFromMessage);
    const handleSlashRedo = useSessionUIStore((s) => s.handleSlashRedo);
    const [restoringId, setRestoringId] = React.useState<string | null>(null);
    const [forkingId, setForkingId] = React.useState<string | null>(null);
    const [collapsed, setCollapsed] = React.useState(true);
    const revertedStateRef = React.useRef<RevertedMessageDockState>(EMPTY_REVERTED_MESSAGE_DOCK_STATE);
    const revertedState = useDirectorySync(
        React.useCallback((state) => {
            const next = buildRevertedMessageDockState(state, sessionId, revertedStateRef.current);
            revertedStateRef.current = next;
            return next;
        }, [sessionId]),
        directory,
    );
    const revertMessageID = revertedState.revertMessageID;
    const userMessages = React.useMemo(
        () => revertedState.records.map((record) => record.message),
        [revertedState],
    );
    const noTextContent = t('chat.revertPopover.noTextContent');
    const items = React.useMemo(() => {
        if (!revertMessageID) return [];
        return revertedState.records.map((record) => ({
            id: record.message.id,
            text: getRevertedPreview(record.parts, noTextContent),
        }));
    }, [noTextContent, revertMessageID, revertedState]);
    const firstRevertedMessageId = items[0]?.id;

    React.useEffect(() => {
        setCollapsed(true);
    }, [revertMessageID, firstRevertedMessageId]);

    const handleRestore = React.useCallback(async (messageId: string) => {
        if (!sessionId || restoringId) return;
        setRestoringId(messageId);
        try {
            const messageIndex = userMessages.findIndex((message) => message.id === messageId);
            const nextMessage = messageIndex >= 0 ? userMessages[messageIndex + 1] : undefined;
            if (nextMessage) {
                await revertToMessage(sessionId, nextMessage.id, { skipRedoPush: true });
            } else {
                await handleSlashRedo(sessionId, { fullUnrevert: true });
            }
        } finally {
            setRestoringId(null);
        }
    }, [handleSlashRedo, revertToMessage, restoringId, sessionId, userMessages]);

    const handleFork = React.useCallback(async (messageId: string) => {
        if (!sessionId || forkingId) return;
        setForkingId(messageId);
        try {
            await forkFromMessage(sessionId, messageId);
        } finally {
            setForkingId(null);
        }
    }, [forkFromMessage, forkingId, sessionId]);

    if (!sessionId || items.length === 0) return null;

    return (
        <div className="pb-2 w-full px-1">
            <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-sm overflow-hidden">
                <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-[var(--interactive-hover)] transition-colors"
                    onClick={() => setCollapsed((value) => !value)}
                    aria-expanded={!collapsed}
                >
                    <span className="typography-ui-label font-medium text-foreground flex-shrink-0">
                        {t('chat.revertPopover.title')} messages {items.length}
                    </span>
                    <Icon
                        name="arrow-down-s"
                        className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", !collapsed && "rotate-180")}
                        aria-hidden="true"
                    />
                </button>
                {!collapsed && (
                    <div className="px-3 pb-3 flex flex-col gap-1.5 max-h-[10.5rem] overflow-y-auto">
                        {items.map((item) => (
                            <div key={item.id} className="flex min-w-0 items-center gap-2 py-1">
                                <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">
                                    {item.text}
                                </span>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="xs"
                                    disabled={Boolean(restoringId || forkingId)}
                                    onClick={() => { void handleFork(item.id); }}
                                >
                                    {forkingId === item.id ? (
                                        <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
                                    ) : (
                                        <Icon name="git-branch" className="h-3 w-3" aria-hidden="true" />
                                    )}
                                    {t('chat.revertPopover.fork')}
                                </Button>
                                <Button
                                    type="button"
                                    variant="secondary"
                                    size="xs"
                                    disabled={Boolean(restoringId || forkingId)}
                                    onClick={() => { void handleRestore(item.id); }}
                                >
                                    {restoringId === item.id ? (
                                        <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
                                    ) : (
                                        <Icon name="arrow-go-forward" className="h-3 w-3" aria-hidden="true" />
                                    )}
                                    {t('chat.revertPopover.restore')}
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
});

RevertedMessageDock.displayName = 'RevertedMessageDock';
