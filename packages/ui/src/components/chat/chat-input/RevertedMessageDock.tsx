import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync } from '@/sync/sync-context';
import { getRevertedPreview } from './utils';
import { EMPTY_MESSAGES } from './constants';
import type { Message } from '@opencode-ai/sdk/v2/client';

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
    const revertMessageID = useDirectorySync(
        React.useCallback((state) => {
            if (!sessionId) return undefined;
            const session = state.session.find((item) => item.id === sessionId);
            return (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID;
        }, [sessionId]),
        directory,
    );
    const sessionMessages = useDirectorySync(
        React.useCallback((state) => (sessionId ? state.message[sessionId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES), [sessionId]),
        directory,
    );
    const partsByMessage = useDirectorySync(React.useCallback((state) => state.part, []), directory);

    const userMessages = React.useMemo(
        () => sessionMessages.filter((message): message is Message & { role: 'user' } => message.role === 'user'),
        [sessionMessages],
    );
    const noTextContent = t('chat.revertPopover.noTextContent');
    const items = React.useMemo(() => {
        if (!revertMessageID) return [];
        return userMessages
            .filter((message) => message.id >= revertMessageID)
            .map((message) => ({
                id: message.id,
                text: getRevertedPreview(partsByMessage[message.id] ?? [], noTextContent),
            }));
    }, [noTextContent, partsByMessage, revertMessageID, userMessages]);
    const firstRevertedMessageId = items[0]?.id;

    React.useEffect(() => {
        setCollapsed(true);
    }, [revertMessageID, firstRevertedMessageId]);

    const handleRestore = React.useCallback(async (messageId: string) => {
        if (!sessionId || restoringId) return;
        setRestoringId(messageId);
        try {
            const nextMessage = userMessages.find((message) => message.id > messageId);
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
