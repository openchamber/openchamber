import React from 'react';
import { useRevertBarHidden } from '@/sync/revert-bar-visibility';
import type { Part } from '@/lib/opencode/model';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useSourceControlDescriptorOf, type SourceControlDescriptorOf } from '@/lib/source-control/providers/registry';
import { clearStagedRevert } from '@/sync/session-actions';
import { attachmentBasename } from '@/lib/attachmentIdentity';
import { useDirectorySync } from '@/sync/sync-context';
import { readSubagentRun } from '@/lib/opencode/subagent-run';
import { attachSyntheticContext } from './lib/attachSyntheticContext';
import { getPromptPreviewText } from './lib/messagePreview';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
    EMPTY_REVERTED_MESSAGE_DOCK_STATE,
    buildRevertedMessageDockState,
    type RevertedMessageDockState,
} from './revertedMessageDockState';

const getRevertedPreview = (
    parts: Part[],
    fallback: string,
    t: Parameters<typeof getPromptPreviewText>[1],
    descriptorOf: SourceControlDescriptorOf,
): string => {
    const text = getPromptPreviewText(parts, t, descriptorOf).replace(/\s+/g, ' ').trim();
    if (text) return text;
    const filePart = parts.find((part) => part.type === 'file');
    return filePart?.filename ? `[${attachmentBasename(filePart.filename)}]` : fallback;
};

const ROW_CLASS = 'flex oc-composer-row min-w-0 items-center gap-2 ps-3 pe-1.5';

interface RevertedMessagesStripProps {
    sessionId: string | null;
    directory?: string;
}

export const RevertedMessagesStrip: React.FC<RevertedMessagesStripProps> = React.memo(({ sessionId, directory }) => {
    const { t } = useI18n();
    const descriptorOf = useSourceControlDescriptorOf();
    const [restoring, setRestoring] = React.useState(false);
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
        const entries = attachSyntheticContext(revertedState.records.map((record) => ({ info: record.message, parts: record.parts })));
        return entries.flatMap(({ info, parts }) => {
            if (info.role === 'user') return [{ id: info.id, text: getRevertedPreview(parts, noTextContent, t, descriptorOf) }];
            if (info.role === 'synthetic' && readSubagentRun(info)) return [{ id: info.id, text: info.description?.trim() || noTextContent }];
            return [];
        });
    }, [descriptorOf, noTextContent, revertedState, t]);

    const takenBack = useRevertBarHidden(sessionId, revertedState.revertMessageID);

    if (!sessionId || !revertedState.revertMessageID || items.length === 0 || takenBack) return null;

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
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex shrink-0">
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
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>{t(items.length === 1 ? 'contextTooltips.chat.restoreOne' : 'contextTooltips.chat.restoreAll')}</TooltipContent>
        </Tooltip>
    );

    if (items.length === 1) {
        return (
            <div role="group" className={`${ROW_CLASS} border-b border-edge`} aria-label={t('chat.revertPopover.title')}>
                <Icon name="arrow-go-back" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{items[0].text}</span>
                {restoreButton}
            </div>
        );
    }

    const expansionKey = `${revertedState.revertMessageID}:${items[0].id}`;
    const expanded = expandedFor === expansionKey;

    return (
        <div role="group" className="border-b border-edge" aria-label={t('chat.revertPopover.title')}>
            <div className="flex oc-composer-row items-center gap-2 ps-3 pe-1.5">
                <Tooltip>
                    <TooltipTrigger asChild>
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
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>{t(expanded ? 'contextTooltips.chat.revertedHide' : 'contextTooltips.chat.revertedShow')}</TooltipContent>
                </Tooltip>
                {restoreButton}
            </div>
            {expanded ? (
                <ScrollableOverlay id={listId} outerClassName="max-h-40" className="overscroll-contain" disableHorizontal>
                    {items.map((item) => (
                        <div key={item.id} className={ROW_CLASS}>
                            <span className="size-3.5 shrink-0" aria-hidden="true" />
                            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{item.text}</span>
                        </div>
                    ))}
                </ScrollableOverlay>
            ) : null}
        </div>
    );
});

RevertedMessagesStrip.displayName = 'RevertedMessagesStrip';
