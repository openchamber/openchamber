import React from 'react';
import type { Part } from '@/lib/opencode/model';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useSourceControlDescriptorOf, type SourceControlDescriptorOf } from '@/lib/source-control/providers/registry';
import { clearStagedRevert } from '@/sync/session-actions';
import { useDirectorySync } from '@/sync/sync-context';
import { readSubagentRun } from '@/lib/opencode/subagent-run';
import { attachSyntheticContext } from './lib/attachSyntheticContext';
import { getPromptPreviewText } from './lib/messagePreview';
import {
    EMPTY_REVERTED_MESSAGE_DOCK_STATE,
    buildRevertedMessageDockState,
    type RevertedMessageDockState,
} from './revertedMessageDockState';

/**
 * A one-line preview of a reverted prompt, read the way the navigator reads
 * it: the typed text, else a label for its attached context (a quote, a
 * terminal selection), else an attached filename, else `fallback`.
 */
const getRevertedPreview = (
    parts: Part[],
    fallback: string,
    t: Parameters<typeof getPromptPreviewText>[1],
    descriptorOf: SourceControlDescriptorOf,
): string => {
    const text = getPromptPreviewText(parts, t, descriptorOf).replace(/\s+/g, ' ').trim();
    if (text) return text;
    const filePart = parts.find((part) => part.type === 'file');
    return filePart?.filename ? `[${filePart.filename}]` : fallback;
};

const ROW_CLASS = 'flex oc-composer-row min-w-0 items-center gap-2 ps-3 pe-1.5';

interface RevertedMessagesStripProps {
    sessionId: string | null;
    directory?: string;
}

/**
 * A staged revert, as a top row of the composer. OpenCode v2 stages a revert:
 * the messages after the revert point are hidden and the agent's file changes
 * from those turns are rolled back. The next message drops them for good
 * (OpenCode commits the revert before admitting it), so the only decision left
 * here is Restore, which puts the messages and the files back. One reverted
 * message is its own row; several collapse into a count that expands in place.
 */
export const RevertedMessagesStrip: React.FC<RevertedMessagesStripProps> = React.memo(({ sessionId, directory }) => {
    const { t } = useI18n();
    const descriptorOf = useSourceControlDescriptorOf();
    const [restoring, setRestoring] = React.useState(false);
    // The list opens for one revert point; a new revert starts collapsed.
    const [expandedFor, setExpandedFor] = React.useState<string | null>(null);
    const listId = React.useId();
    const revertedStateRef = React.useRef<RevertedMessageDockState>(EMPTY_REVERTED_MESSAGE_DOCK_STATE);
    const revertedState = useDirectorySync(
        React.useCallback((state) => {
            const next = buildRevertedMessageDockState(state, sessionId, revertedStateRef.current);
            revertedStateRef.current = next;
            return next;
        }, [sessionId]),
        directory,
    );
    const noTextContent = t('chat.revertPopover.noTextContent');
    const items = React.useMemo(() => {
        // Attached context arrives as synthetic messages around its prompt;
        // folding it back on gives a quote-only prompt its label, and drops
        // plugin plumbing. A background report stays its own row.
        const entries = attachSyntheticContext(revertedState.records.map((record) => ({ info: record.message, parts: record.parts })));
        return entries.flatMap(({ info, parts }) => {
            if (info.role === 'user') return [{ id: info.id, text: getRevertedPreview(parts, noTextContent, t, descriptorOf) }];
            if (info.role === 'synthetic' && readSubagentRun(info)) return [{ id: info.id, text: info.description?.trim() || noTextContent }];
            return [];
        });
    }, [descriptorOf, noTextContent, revertedState, t]);

    if (!sessionId || !revertedState.revertMessageID || items.length === 0) return null;

    const restore = async () => {
        if (restoring) return;
        setRestoring(true);
        try {
            await clearStagedRevert(sessionId);
        } catch (error) {
            console.warn('[revert] failed to restore reverted messages:', error);
            toast.error(t('chat.revertPopover.toast.restoreFailed'));
        } finally {
            setRestoring(false);
        }
    };

    const restoreButton = (
        <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={restoring}
            onClick={() => { void restore(); }}
            onMouseDown={(event) => event.preventDefault()}
            className="shrink-0 text-primary/80 hover:bg-transparent hover:text-primary"
        >
            {restoring ? <Icon name="loader-4" className="size-3 animate-spin" aria-hidden="true" /> : null}
            {items.length === 1 ? t('chat.revertPopover.restore') : t('chat.revertPopover.restoreAll')}
        </Button>
    );

    if (items.length === 1) {
        return (
            <div role="group" className={`${ROW_CLASS} border-b border-border/60`} aria-label={t('chat.revertPopover.title')}>
                <Icon name="arrow-go-back" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{items[0].text}</span>
                {restoreButton}
            </div>
        );
    }

    const expansionKey = `${revertedState.revertMessageID}:${items[0].id}`;
    const expanded = expandedFor === expansionKey;

    // The header toggles the list, as the background commands header does;
    // Restore stays on it, so the decision never hides behind the toggle.
    return (
        <div role="group" className="border-b border-border/60" aria-label={t('chat.revertPopover.title')}>
            <div className="flex oc-composer-row items-center gap-2 ps-3 pe-1.5">
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpandedFor(expanded ? null : expansionKey)}
                    onMouseDown={(event) => event.preventDefault()}
                    aria-expanded={expanded}
                    aria-controls={expanded ? listId : undefined}
                    className="min-w-0 flex-1 shrink justify-start gap-2 px-0 text-sm font-normal normal-case text-muted-foreground hover:!bg-transparent hover:text-foreground has-[>svg]:px-0"
                >
                    <Icon name="arrow-go-back" className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 truncate text-start">
                        {t('chat.revertPopover.staged', { count: items.length })}
                    </span>
                    <Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" aria-hidden="true" />
                </Button>
                {restoreButton}
            </div>
            {expanded ? (
                <div id={listId} className="max-h-40 overflow-y-auto overscroll-contain">
                    {items.map((item) => (
                        <div key={item.id} className={ROW_CLASS}>
                            {/* Lines the text up with the header label after its icon. */}
                            <span className="size-3.5 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{item.text}</span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
});

RevertedMessagesStrip.displayName = 'RevertedMessagesStrip';
