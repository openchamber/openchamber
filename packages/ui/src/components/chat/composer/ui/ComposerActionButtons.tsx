
import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { StopIcon } from '@/components/icons/StopIcon';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { useUIStore } from '@/stores/useUIStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type ComposerActionButtonsProps = {
    isMobile: boolean;
    footerIconButtonClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;
    canSend: boolean;
    canAbort: boolean;
    hasContent: boolean;
    currentSessionId: string | null;
    newSessionDraftOpen: boolean;
    onPrimaryAction: () => void;
    onAbort: () => void;
    sendLabel?: string;
    escapeStops?: boolean;
};

export const ComposerActionButtons = React.memo(function ComposerActionButtons(props: ComposerActionButtonsProps) {
    const {
        isMobile,
        footerIconButtonClass,
        sendIconSizeClass,
        stopIconSizeClass,
        canSend,
        canAbort,
        hasContent,
        currentSessionId,
        newSessionDraftOpen,
        onPrimaryAction,
        onAbort,
        sendLabel,
        escapeStops = false,
    } = props;
    const { t } = useI18n();
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const queuesFollowUp = useMessageQueueStore((state) => state.followUpBehavior) === 'queue';
    const escapeKey = escapeStops ? formatShortcutForDisplay(getEffectiveShortcutCombo('abort_run', shortcutOverrides), '') : '';
    const abortShortcut = escapeKey ? `${escapeKey} ${escapeKey}` : undefined;

    const discSized = !isMobile && !isVSCodeRuntime();
    const actionSlotClass = cn(footerIconButtonClass, discSized && 'h-7 w-7', isMobile && 'justify-end');
    const discClass = cn('oc-action-disc', isMobile ? 'size-7' : 'size-full');
    const stopText = t('chat.chatInput.actions.stopGeneratingAria');

    if (canAbort && !hasContent) {
        return (
            <Tooltip>
            <TooltipTrigger asChild>
            <button
                type="button"
                onClick={onAbort}
                className={actionSlotClass}
                aria-label={stopText}
            >
                <span className={discClass} data-idle="">
                    <StopIcon className={cn(stopIconSizeClass, 'text-[var(--status-error)]')} />
                </span>
            </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}><TooltipLabelWithShortcut label={stopText} shortcut={abortShortcut} /></TooltipContent>
            </Tooltip>
        );
    }

    const followUp = canAbort;
    const sendEnabled = followUp
        ? Boolean(currentSessionId)
        : canSend && Boolean(currentSessionId || newSessionDraftOpen);
    const sendText = followUp
        ? t(queuesFollowUp ? 'chat.chatInput.actions.queueMessageAria' : 'chat.chatInput.actions.sendMessageAria')
        : sendLabel ?? t('chat.chatInput.actions.sendMessageAria');
    const sendButton = (
        <button
            type={isMobile || followUp ? 'button' : 'submit'}
            disabled={!sendEnabled}
            onClick={(event) => {
                if (!isMobile && !followUp) {
                    return;
                }

                event.preventDefault();
                onPrimaryAction();
            }}
            className={actionSlotClass}
            aria-label={sendText}
        >
            <span className={discClass} data-idle={sendEnabled ? undefined : ''}>
                <Icon name="arrow-up" className={cn(sendIconSizeClass)} />
            </span>
        </button>
    );

    const visibleStop = followUp && !escapeStops ? (
        <Tooltip>
            <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={onAbort}
                    className={footerIconButtonClass}
                    aria-label={stopText}
                >
                    <StopIcon className={cn(stopIconSizeClass, 'text-[var(--status-error)]')} />
                </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>{stopText}</TooltipContent>
        </Tooltip>
    ) : null;

    if (isMobile) return visibleStop ? <>{visibleStop}{sendButton}</> : sendButton;
    const sendWithTooltip = (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex">{sendButton}</span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                {followUp && abortShortcut ? (
                    <span className="inline-flex items-center gap-1.5">
                        {sendText}
                        <span aria-hidden="true" className="text-muted-foreground">·</span>
                        <TooltipLabelWithShortcut label={stopText} shortcut={abortShortcut} />
                    </span>
                ) : sendText}
            </TooltipContent>
        </Tooltip>
    );
    return visibleStop ? <>{visibleStop}{sendWithTooltip}</> : sendWithTooltip;
}, (prev, next) => (
    prev.isMobile === next.isMobile
    && prev.footerIconButtonClass === next.footerIconButtonClass
    && prev.sendIconSizeClass === next.sendIconSizeClass
    && prev.stopIconSizeClass === next.stopIconSizeClass
    && prev.canSend === next.canSend
    && prev.canAbort === next.canAbort
    && prev.hasContent === next.hasContent
    && prev.currentSessionId === next.currentSessionId
    && prev.newSessionDraftOpen === next.newSessionDraftOpen
    && prev.onPrimaryAction === next.onPrimaryAction
    && prev.onAbort === next.onAbort
    && prev.sendLabel === next.sendLabel
    && prev.escapeStops === next.escapeStops
));
