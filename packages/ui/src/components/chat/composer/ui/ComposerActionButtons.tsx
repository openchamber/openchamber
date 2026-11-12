/**
 * The composer's send / queue / stop control.
 *
 * One disc in one slot: idle it sends; a busy session without content shows
 * Stop; a busy session with content shows Send again, which does what Enter
 * does under the follow-up setting (queues or steers). Stop with a draft
 * typed stays on double Escape where it reaches this composer (the Send
 * tooltip names it), and is a bare icon beside Send everywhere else.
 */

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
    /** Replaces "Send message" as the accessible name and tooltip (parallel mode says how many runs start). */
    sendLabel?: string;
    /**
     * Double Escape in this composer stops its run (abortShortcutReach). With
     * it, a draft typed during a run turns the one disc into Send and the
     * tooltip names the shortcut; without it, a bare Stop stays beside Send.
     */
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
    // Stopping takes Escape twice (a single press only arms it).
    const escapeKey = escapeStops ? formatShortcutForDisplay(getEffectiveShortcutCombo('abort_run', shortcutOverrides), '') : '';
    const abortShortcut = escapeKey ? `${escapeKey} ${escapeKey}` : undefined;

    // One disc in one slot at all times (`.oc-action-disc`: the composer's
    // text colour, the glyph cut out in its fill, flat). Idle it sends. While
    // a turn runs it is Stop, until the input holds something to send: then
    // it is Send again and does what Enter does under the follow-up setting
    // (queue or steer); double Escape still stops. A second control stacked
    // above Stop read as a stray mark (maintainer, 2026-11-12). The disc is
    // 28px on desktop; VS Code draws it at its footer's button size, and on
    // a phone the button keeps the footer's touch target with the disc inside.
    const discSized = !isMobile && !isVSCodeRuntime();
    const actionSlotClass = cn(footerIconButtonClass, discSized && 'h-7 w-7');
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
                {/* The quiet disc, as an idle Send: a bright disc for the whole
                    length of a run pulled the eye, and only a draft to send
                    earns the bright one. The stop square alone takes the
                    theme's error colour (maintainer, 2026-11-12). */}
                <span className={discClass} data-idle="">
                    <StopIcon className={cn(stopIconSizeClass, 'text-[var(--status-error)]')} />
                </span>
            </button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}><TooltipLabelWithShortcut label={stopText} shortcut={abortShortcut} /></TooltipContent>
            </Tooltip>
        );
    }

    // A turn is running and the input has something to send: a follow-up.
    const followUp = canAbort;
    const sendEnabled = followUp
        ? Boolean(currentSessionId)
        : canSend && Boolean(currentSessionId || newSessionDraftOpen);
    const sendText = followUp
        ? t(queuesFollowUp ? 'chat.chatInput.actions.queueMessageAria' : 'chat.chatInput.actions.sendMessageAria')
        : sendLabel ?? t('chat.chatInput.actions.sendMessageAria');
    const sendButton = (
        <button
            // A follow-up goes through the primary action (queue or steer),
            // never the form submit.
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
            {/* Disabled, it rests as a quiet disc with the muted glyph:
                present, not pressable. */}
            <span className={discClass} data-idle={sendEnabled ? undefined : ''}>
                <Icon name="arrow-up" className={cn(sendIconSizeClass)} />
            </span>
        </button>
    );

    // Where double Escape cannot stop this run (BTW, a touch device, a surface
    // not wired to the shortcut), Stop stays visible: a bare icon before the
    // disc, so the disc keeps its place.
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
                {/* The span keeps the tooltip on a disabled button, which takes no pointer events. */}
                <span className="inline-flex">{sendButton}</span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                {followUp && abortShortcut ? (
                    // Stop is away while a follow-up is typed; its shortcut is not.
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
