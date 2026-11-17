
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
    messageContent?: React.ReactNode;
    sessionId: string | null;
    newSessionDraftOpen: boolean;
    hasContent: boolean;
    isVSCode: boolean;
    canAbort: boolean;
    footerIconButtonClass: string;
    iconSizeClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;
    topRow?: React.ReactNode;
    attachments?: React.ReactNode;
    bottomRow?: React.ReactNode;
    onExpand: () => void;
    onPrimaryAction: () => void;
    onPickLocalFiles: () => void;
    onOpenGitHubPicker: () => void;
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
        messageContent,
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
                data-composer-box="true"
                className={cn(
                    'oc-surface-floating oc-composer-surface oc-glass-floating oc-composer-sheen flex min-w-0 flex-col',
                    topRow || bottomRow ? 'rounded-[1.25rem]' : 'rounded-full',
                )}
            >
            {topRow}
            {attachments}
            <div className="flex h-12 min-w-0 items-center gap-x-0.5 ps-2.5 pe-3.5">
                <div className="composer-mobile-actions flex flex-shrink-0 items-center">
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
                </div>
                <button
                    type="button"
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
                            ? messageContent ?? message
                            : currentSessionId || newSessionDraftOpen
                                ? t('chat.chatInput.placeholder.chatCompact')
                                : t('chat.chatInput.placeholder.selectSession')}
                    </span>
                </button>
                <div className="flex flex-shrink-0 items-center gap-x-1">
                {showDictation ? (
                    <Tooltip>
                    <TooltipTrigger asChild>
                    <button
                        type="button"
                        className={footerIconButtonClass}
                        onClick={onStartDictation}
                        aria-label={t('chat.dictation.start')}
                    >
                        <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                    </button>
                    </TooltipTrigger>
                    <TooltipContent side="top"><TooltipLabelWithShortcut label={t('chat.dictation.start')} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_dictation', shortcutOverrides), '')} /></TooltipContent>
                    </Tooltip>
                ) : null}
                {canAbort ? (
                    <button
                        type="button"
                        className={cn(footerIconButtonClass, !hasContent && 'justify-end')}
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
                        className={cn(footerIconButtonClass, 'justify-end')}
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
            </div>
            {bottomRow}
            </div>
            </div>
        </div>
    );
}
