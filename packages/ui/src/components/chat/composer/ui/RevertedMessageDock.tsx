/**
 * The staged-revert dock.
 *
 * OpenCode v2 stages a revert instead of applying it: the messages behind the
 * revert point stay in the session, listed here, until the user either commits
 * the revert (drops them for good) or clears it (puts the session back). There
 * is no un-revert any more, so the dock offers exactly those two decisions,
 * plus forking a new session from any of the staged messages.
 */

import { clearStagedRevert, commitStagedRevert } from '@/sync/session-actions';
import React from 'react';
import type { Part } from '@/lib/opencode/model';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
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
        .filter((part) => part.type === 'text')
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();

    if (text) return text;
    const filePart = parts.find((part) => part.type === 'file');
    return filePart?.filename ? `[${filePart.filename}]` : fallback;
};

type RevertedMessageDockProps = {
    sessionId: string | null;
    directory?: string;
};

export const RevertedMessageDock: React.FC<RevertedMessageDockProps> = React.memo(({ sessionId, directory }) => {
    const { t } = useI18n();
    const forkFromMessage = useSessionUIStore((s) => s.forkFromMessage);
    const [settling, setSettling] = React.useState<'commit' | 'clear' | null>(null);
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

    const handleCommit = React.useCallback(async () => {
        if (!sessionId || settling) return;
        setSettling('commit');
        try {
            await commitStagedRevert(sessionId);
        } finally {
            setSettling(null);
        }
    }, [sessionId, settling]);

    const handleClear = React.useCallback(async () => {
        if (!sessionId || settling) return;
        setSettling('clear');
        try {
            await clearStagedRevert(sessionId);
        } finally {
            setSettling(null);
        }
    }, [sessionId, settling]);

    const handleFork = React.useCallback(async (messageId: string) => {
        if (!sessionId || forkingId || settling) return;
        setForkingId(messageId);
        try {
            await forkFromMessage(sessionId, messageId);
        } finally {
            setForkingId(null);
        }
    }, [forkFromMessage, forkingId, sessionId, settling]);

    if (!sessionId || items.length === 0) return null;

    return (
        <div className="pb-2 w-full px-1">
            <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] text-[var(--surface-elevated-foreground)] shadow-sm overflow-hidden">
                <div className="flex w-full items-center gap-2 px-3 py-2">
                    <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        onClick={() => setCollapsed((value) => !value)}
                        aria-expanded={!collapsed}
                    >
                    <span className="typography-ui-label font-medium text-foreground flex-shrink-0">
                        {t('chat.revertPopover.staged', { count: items.length })}
                    </span>
                        <Icon
                            name="arrow-down-s"
                            className={cn("ml-auto h-4 w-4 text-muted-foreground transition-transform", !collapsed && "rotate-180")}
                            aria-hidden="true"
                        />
                    </button>
                    {/* The staged revert settles one way or the other: commit
                        drops the listed messages, clear puts the session back. */}
                    <Button
                        type="button"
                        variant="secondary"
                        size="xs"
                        disabled={Boolean(settling || forkingId)}
                        onClick={() => { void handleClear(); }}
                    >
                        {settling === 'clear' ? (
                            <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
                        ) : (
                            <Icon name="arrow-go-back" className="h-3 w-3" aria-hidden="true" />
                        )}
                        {t('chat.revertPopover.clear')}
                    </Button>
                    <Button
                        type="button"
                        variant="destructive"
                        size="xs"
                        disabled={Boolean(settling || forkingId)}
                        onClick={() => { void handleCommit(); }}
                    >
                        {settling === 'commit' ? (
                            <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
                        ) : (
                            <Icon name="check" className="h-3 w-3" aria-hidden="true" />
                        )}
                        {t('chat.revertPopover.commit')}
                    </Button>
                </div>
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
                                    disabled={Boolean(settling || forkingId)}
                                    onClick={() => { void handleFork(item.id); }}
                                >
                                    {forkingId === item.id ? (
                                        <Icon name="loader-4" className="h-3 w-3 animate-spin" aria-hidden="true" />
                                    ) : (
                                        <Icon name="git-branch" className="h-3 w-3" aria-hidden="true" />
                                    )}
                                    {t('chat.revertPopover.fork')}
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
