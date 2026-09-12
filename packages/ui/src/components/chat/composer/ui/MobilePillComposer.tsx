/**
 * The collapsed mobile composer.
 *
 * With the keyboard down the composer is a pill: attachments, a one-line
 * preview of the draft, and a mic. Tapping anywhere in it expands the real
 * composer and raises the keyboard in the same gesture — which is why the
 * expand handler must run synchronously from the tap rather than from an
 * effect.
 *
 * With content, the inner end slot sends while the session is idle. While it
 * is running, abort keeps that slot and a round queue action appears beside
 * the pill; otherwise nothing sits beside it.
 */

import type React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { StopIcon } from '@/components/icons/StopIcon';
import { SessionGoalRow } from '@/components/chat/SessionGoalRow';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ComposerAttachmentControls } from './ComposerAttachmentControls';

export interface MobilePillComposerProps {
    message: string;
    sessionId: string | null;
    directory?: string;
    newSessionDraftOpen: boolean;
    hasContent: boolean;
    isVSCode: boolean;
    canAbort: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;
    /** Rendered as the pill's own first row (the suggested follow-up). */
    topRow?: React.ReactNode;
    /** Attached files, shown inside the pill above the draft line. */
    attachments?: React.ReactNode;
    /** Rendered as the pill's own last row (mobile model/agent controls). */
    bottomRow?: React.ReactNode;
    onExpand: () => void;
    onPrimaryAction: () => void;
    /** While a turn runs, the trailing action queues, as the expanded composer does. */
    onQueueMessage: () => void;
    onPickLocalFiles: () => void;
    onOpenIssuePicker: () => void;
    onOpenPrPicker: () => void;
    showLinearPicker?: boolean;
    onOpenLinearPicker?: () => void;
    onOpenAttachSheet: () => void;
    onStartDictation: () => void;
    onAbort: () => void;
}

export function MobilePillComposer(props: MobilePillComposerProps) {
    const { t } = useI18n();
    const {
        message,
        sessionId: currentSessionId,
        directory,
        newSessionDraftOpen,
        hasContent,
        isVSCode,
        canAbort,
        footerIconButtonClass,
        iconSizeClass,
        sendIconSizeClass,
        stopIconSizeClass,
        topRow,
        attachments,
        bottomRow,
        onExpand,
        onPrimaryAction,
        onQueueMessage,
        onPickLocalFiles,
        onOpenIssuePicker,
        onOpenPrPicker,
        showLinearPicker,
        onOpenLinearPicker,
        onOpenAttachSheet,
        onStartDictation,
        onAbort,
    } = props;
    const canPrimaryAction = hasContent && Boolean(currentSessionId || newSessionDraftOpen);
    const showTrailingSendAction = canPrimaryAction && canAbort;

    return (
        <div className="flex flex-col">
        <SessionGoalRow
            sessionId={currentSessionId}
            directory={directory}
            className="mb-1.5"
        />
        <div className="flex items-center">
            <div
                data-mobile-composer-pill="true"
                className={cn(
                    'oc-glass-composer flex min-w-0 flex-1 flex-col border border-border/80 shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)]',
                    topRow || bottomRow ? 'rounded-[1.5rem]' : 'rounded-full',
                )}
            >
            {topRow}
            {attachments}
            {/* pl-1 puts the attach icon at the same inset the expanded
                footer gives it, and h-12 is the expanded footer's height
                (its buttons sit on the mobile 36px touch floor), so the icons
                do not shift across the swap. */}
            <div className="flex h-12 min-w-0 items-center gap-x-0.5 pl-1 pr-1">
                <ComposerAttachmentControls
                    isVSCode={isVSCode}
                    footerIconButtonClass={footerIconButtonClass}
                    iconSizeClass={iconSizeClass}
                    handlePickLocalFiles={onPickLocalFiles}
                    openIssuePicker={onOpenIssuePicker}
                    openPrPicker={onOpenPrPicker}
                    showLinearPicker={showLinearPicker}
                    openLinearPicker={onOpenLinearPicker}
                    onOpenMobileSheet={onOpenAttachSheet}
                />
                <button
                    type="button"
                    className="flex h-full min-w-0 flex-1 cursor-text items-center px-1.5 text-left"
                    onClick={onExpand}
                >
                    <span
                        className={cn(
                            'truncate typography-ui-label',
                            message.trim() ? 'text-foreground' : 'text-muted-foreground/40',
                        )}
                    >
                        {message.trim()
                            ? message
                            : currentSessionId || newSessionDraftOpen
                                ? t('chat.chatInput.placeholder.chatCompact')
                                : t('chat.chatInput.placeholder.selectSession')}
                    </span>
                </button>
                <button
                    type="button"
                    className={footerIconButtonClass}
                    // Starts recording in place; the composer morphs into the
                    // voice variant once dictation actually goes live.
                    onClick={onStartDictation}
                    title={t('chat.dictation.start')}
                    aria-label={t('chat.dictation.start')}
                >
                    <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                </button>
                {/* Same visibility rule as the full composer's stop control:
                    while a turn is running the stop button takes the mic's
                    end slot and the mic shifts one slot left. Instant swap —
                    no shape animation (WKWebView). */}
                {canAbort ? (
                    <button
                        type="button"
                        className={cn(footerIconButtonClass, 'text-[var(--status-error)] hover:text-[var(--status-error)]')}
                        // The pill shows only while the keyboard is down — the
                        // tap must abort in place, never focus/expand the
                        // composer or raise the keyboard.
                        onMouseDown={(event) => event.preventDefault()}
                        onPointerDownCapture={(event) => {
                            if (event.pointerType === 'touch') {
                                event.preventDefault();
                            }
                        }}
                        onClick={(event) => {
                            event.stopPropagation();
                            onAbort();
                        }}
                        title={t('chat.chatInput.actions.stopGeneratingAria')}
                        aria-label={t('chat.chatInput.actions.stopGeneratingAria')}
                    >
                        <StopIcon className={cn(stopIconSizeClass)} />
                    </button>
                ) : canPrimaryAction ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-primary hover:text-primary"
                        onClick={onPrimaryAction}
                        title={t('chat.chatInput.actions.sendMessageAria')}
                        aria-label={t('chat.chatInput.actions.sendMessageAria')}
                    >
                        <Icon name="send-plane-2" className={cn(sendIconSizeClass)} />
                    </Button>
                ) : null}
            </div>
            {bottomRow}
            </div>
            {/* While running, Abort owns the pill's end slot and this outer
                button queues the draft, with the same rotated icon and label
                the expanded composer uses for that state. Collapsed otherwise. */}
            <div
                className={cn(
                    'flex-shrink-0 transition-all duration-200 ease-out',
                    // The gap lives on the slot, so a collapsed slot leaves
                    // the pill exactly as wide as the expanded box.
                    showTrailingSendAction ? 'ml-2 w-11 opacity-100' : 'w-0 opacity-0 overflow-hidden',
                )}
            >
                <button
                    type="button"
                    className="oc-glass-composer flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-border/80 text-primary shadow-[0_4px_16px_-4px_rgb(0_0_0_/_0.12)] hover:text-primary"
                    onClick={onQueueMessage}
                    disabled={!showTrailingSendAction}
                    tabIndex={showTrailingSendAction ? undefined : -1}
                    title={t('chat.chatInput.actions.queueMessageAria')}
                    aria-label={t('chat.chatInput.actions.queueMessageAria')}
                >
                    <Icon name="send-plane-2" className={cn(sendIconSizeClass, '-rotate-90', 'text-current')} />
                </button>
            </div>
        </div>
        </div>
    );
}
