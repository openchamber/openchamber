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
 * is running, abort keeps that slot and a follow-up action appears just before
 * it, inside the pill: it queues or steers as Enter does under the follow-up
 * setting.
 */

import React, { useState } from 'react';
import type { SourceControlProvider } from '@/lib/api/types';
import { Icon } from '@/components/icon/Icon';
import { StopIcon } from '@/components/icons/StopIcon';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { ComposerAttachmentControls, type ComposerTrackerPicker } from './ComposerAttachmentControls';

export interface MobilePillComposerProps {
    message: string;
    sessionId: string | null;
    newSessionDraftOpen: boolean;
    hasContent: boolean;
    isVSCode: boolean;
    canAbort: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;
    /** The composer's top rows (goal, queue, hints, suggested follow-up), inside the pill. */
    topRow?: React.ReactNode;
    /** Attached files, shown inside the pill above the draft line. */
    attachments?: React.ReactNode;
    /** Rendered as the pill's own last row (mobile model/agent controls). */
    bottomRow?: React.ReactNode;
    onExpand: () => void;
    onPrimaryAction: () => void;
    onPickLocalFiles: () => void;
    onOpenGitHubPicker: () => void;
    /** The host the project's issues and change requests come from. */
    repositoryProvider?: SourceControlProvider | null;
    trackerPickers?: readonly ComposerTrackerPicker[];
    onOpenAttachSheet: () => void;
    onStartDictation: () => void;
    onAbort: () => void;
}

export function MobilePillComposer(props: MobilePillComposerProps) {
    const { t } = useI18n();
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const {
        message,
        sessionId: currentSessionId,
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
        onPickLocalFiles,
        onOpenGitHubPicker,
        repositoryProvider,
        trackerPickers,
        onOpenAttachSheet,
        onStartDictation,
        onAbort,
    } = props;
    const canPrimaryAction = hasContent && Boolean(currentSessionId || newSessionDraftOpen);
    const queuesFollowUp = useMessageQueueStore((state) => state.followUpBehavior) === 'queue';
    const sendLabel = t(canAbort && queuesFollowUp ? 'chat.chatInput.actions.queueMessageAria' : 'chat.chatInput.actions.sendMessageAria');
    const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
    const [dictationSupported] = useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());
    const showDictation = dictationEnabled && dictationSupported;

    return (
        <div className="flex flex-col">
            <div
                className={cn(
                    'flex min-w-0 flex-col',
                    topRow || bottomRow ? 'rounded-[1.25rem]' : 'rounded-full',
                )}
            >
            <div
                data-mobile-composer-pill="true"
                // The morph measures and animates this box (see mobileComposerMorph).
                data-composer-box="true"
                className={cn(
                    // Lit like the desktop composer box: top edge, hairline,
                    // shadow and, in dark themes, the faint sheen.
                    'oc-surface-floating oc-composer-surface oc-glass-floating oc-composer-sheen flex min-w-0 flex-col',
                    topRow || bottomRow ? 'rounded-[1.25rem]' : 'rounded-full',
                )}
            >
            {topRow}
            {attachments}
            {/* ps-1 puts the attach icon at the same inset the expanded
                footer gives it, and h-12 is the expanded footer's height
                (its buttons sit on the mobile 36px touch floor), so the icons
                do not shift across the swap. */}
            <div className="flex h-12 min-w-0 items-center gap-x-0.5 ps-1 pe-1">
                <ComposerAttachmentControls
                    isVSCode={isVSCode}
                    footerIconButtonClass={footerIconButtonClass}
                    iconSizeClass={iconSizeClass}
                    handlePickLocalFiles={onPickLocalFiles}
                    openGitHubPicker={onOpenGitHubPicker}
                    repositoryProvider={repositoryProvider}
                    trackerPickers={trackerPickers}
                    onOpenMobileSheet={onOpenAttachSheet}
                />
                <button
                    type="button"
                    // The morph moves the editor block to and from this line.
                    data-composer-morph-prompt="true"
                    className="flex h-full min-w-0 flex-1 cursor-text items-center px-1.5 text-start"
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
                {showDictation ? (
                    <Tooltip>
                    <TooltipTrigger asChild>
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        // Starts recording in place; the composer morphs into the
                        // voice variant once dictation actually goes live.
                        onClick={onStartDictation}
                        aria-label={t('chat.dictation.start')}
                    >
                        <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                    </button>
                    </TooltipTrigger>
                    <TooltipContent side="top"><TooltipLabelWithShortcut label={t('chat.dictation.start')} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_dictation', shortcutOverrides), '')} /></TooltipContent>
                    </Tooltip>
                ) : null}
                {/* One disc in one slot, as in the expanded composer
                    (ComposerActionButtons): Stop while a turn runs and the
                    input is empty, Send otherwise; a draft typed during a run
                    queues or steers as the setting says. A phone has no
                    Escape to stop with, so while that draft waits Stop stays
                    as a bare icon before the disc. Instant swap, no shape
                    animation (WKWebView). */}
                {canAbort ? (
                    <button
                        type="button"
                        className={footerIconButtonClass}
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
                        {hasContent ? (
                            <StopIcon className={cn(stopIconSizeClass, 'text-[var(--status-error)]')} />
                        ) : (
                            <span className="oc-action-disc size-7" data-idle="">
                                <StopIcon className={cn(stopIconSizeClass, 'text-[var(--status-error)]')} />
                            </span>
                        )}
                    </button>
                ) : null}
                {canPrimaryAction ? (
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        onClick={onPrimaryAction}
                        title={sendLabel}
                        aria-label={sendLabel}
                    >
                        <span className="oc-action-disc size-7">
                            <Icon name="arrow-up" className={cn(sendIconSizeClass)} />
                        </span>
                    </button>
                ) : null}
            </div>
            {bottomRow}
            </div>
            </div>
        </div>
    );
}
