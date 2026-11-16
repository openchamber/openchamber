import React from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useChatSurfaceMode } from '@/components/chat/useChatSurfaceMode';
import { useMessageTTS } from '@/hooks/useMessageTTS';
import { useConfigStore } from '@/stores/useConfigStore';
import type { MessageExtraAction } from './messageBodyProps';
import { AssistantCopyButton } from './AssistantCopyButton';
import { CopyMessageLinkButton } from './CopyMessageLinkButton';
import { MessageExtraActionButtons } from './MessageExtraActionButtons';

interface AssistantMessageActionButtonsProps {
    hasCopyableText: boolean;
    isTouchContext: boolean;
    onCopyMessage?: () => void | boolean | Promise<void | boolean>;
    onCopyLink?: () => void;
    reviewTransferAction?: {
        ariaLabel: string;
        tooltip: string;
        onClick: () => void | Promise<void>;
    };
    onShareImage: (sourceElement?: HTMLElement | null) => Promise<void>;
    ttsText: string;
    // Shared with the message's other reading controls; see useMessageTTS.
    ttsReadingKey?: string;
    extraActions?: MessageExtraAction[];
}

/** The full action row under an assistant text block when the split-actions setting is on. */
export const AssistantMessageActionButtons = React.memo(({
    hasCopyableText,
    isTouchContext,
    onCopyMessage,
    onCopyLink,
    reviewTransferAction,
    onShareImage,
    ttsText,
    ttsReadingKey,
    extraActions,
}: AssistantMessageActionButtonsProps) => {
    const { t } = useI18n();
    const chatSurfaceMode = useChatSurfaceMode();
    const { isPlaying: isTTSPlaying, play: playTTS, stop: stopTTS } = useMessageTTS(ttsReadingKey);
    const showMessageTTSButtons = useConfigStore((state) => state.showMessageTTSButtons);
    const voiceProvider = useConfigStore((state) => state.voiceProvider);
    const [isSharing, setIsSharing] = React.useState(false);
    const [isTransferringReview, setIsTransferringReview] = React.useState(false);

    const handleShareImageClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();

            if (isSharing || !hasCopyableText) {
                return;
            }

            setIsSharing(true);
            try {
            const root = event.currentTarget.closest('[data-message-text-export-root]');
            const sourceElement = root?.querySelector<HTMLElement>('[data-message-text-export-source]') ?? null;
            await onShareImage(sourceElement);
            } finally {
                setIsSharing(false);
            }
        },
        [hasCopyableText, isSharing, onShareImage]
    );

    const handleReviewTransferClick = React.useCallback(
        async (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();
            if (!reviewTransferAction || isTransferringReview || !hasCopyableText) return;
            setIsTransferringReview(true);
            try {
                await reviewTransferAction.onClick();
            } finally {
                setIsTransferringReview(false);
            }
        },
        [hasCopyableText, isTransferringReview, reviewTransferAction]
    );

    const readAloudTooltip = React.useMemo(() => {
        if (isTTSPlaying) {
            return t('chat.messageBody.tts.stopSpeaking');
        }
        const providerLabel = voiceProvider === 'browser'
            ? 'Browser'
            : voiceProvider === 'openai'
                ? 'OpenAI'
                : voiceProvider === 'openai-compatible'
                    ? 'Custom'
                    : 'Say';
        return t('chat.messageBody.tts.readAloudWithProvider', { provider: providerLabel });
    }, [isTTSPlaying, t, voiceProvider]);

    const handleTTSClick = React.useCallback(
        (event: React.MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            event.preventDefault();

            if (isTTSPlaying) {
                stopTTS();
                return;
            }

            if (ttsText.trim()) {
                void playTTS(ttsText);
            }
        },
        [isTTSPlaying, playTTS, stopTTS, ttsText]
    );

    return (
        <>
            {onCopyLink && <CopyMessageLinkButton onCopyLink={onCopyLink} />}
            {onCopyMessage && (
                <AssistantCopyButton hasCopyableText={hasCopyableText} isTouchContext={isTouchContext} onCopyMessage={onCopyMessage} />
            )}
            {reviewTransferAction && chatSurfaceMode !== 'mini-chat' ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            disabled={isTransferringReview || !hasCopyableText}
                            className={cn(
                                'h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring',
                                (!hasCopyableText || isTransferringReview) && 'opacity-50'
                            )}
                            aria-label={reviewTransferAction.ariaLabel}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={(event) => {
                                void handleReviewTransferClick(event);
                            }}
                        >
                            {isTransferringReview ? (
                                <Icon name="loader-4" className="h-3 w-3 animate-spin" />
                            ) : (
                                <Icon name="arrow-left-right" className="h-3 w-3" />
                            )}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{reviewTransferAction.tooltip}</TooltipContent>
                </Tooltip>
            ) : null}
            {chatSurfaceMode !== 'mini-chat' ? <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        disabled={isSharing || !hasCopyableText}
                        className={cn(
                            'h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring',
                            (!hasCopyableText || isSharing) && 'opacity-50'
                        )}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                            void handleShareImageClick(event);
                        }}
                    >
                        {isSharing ? (
                            <Icon name="loader-4" className="h-3 w-3 animate-spin" />
                        ) : (
                            <Icon name="image-download" className="h-3 w-3" />
                        )}
                    </Button>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{isSharing ? t('chat.messageBody.actions.savingImage') : t('chat.messageBody.actions.saveAsImage')}</TooltipContent>
            </Tooltip> : null}
            {chatSurfaceMode !== 'mini-chat' && showMessageTTSButtons && hasCopyableText && (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className={cn(
                                'h-6 w-6 bg-transparent hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring',
                                isTTSPlaying ? 'text-[var(--primary-text)]' : 'text-muted-foreground hover:text-foreground'
                            )}
                            aria-label={isTTSPlaying ? t('chat.messageBody.tts.stopSpeaking') : t('chat.messageBody.tts.readAloud')}
                            onPointerDown={(event) => event.stopPropagation()}
                            onClick={handleTTSClick}
                        >
                            <Icon name="volume-up" className={cn('h-3 w-3', isTTSPlaying && 'text-[var(--primary-text)]')} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent sideOffset={6}>{readAloudTooltip}</TooltipContent>
                </Tooltip>
            )}
            {chatSurfaceMode !== 'mini-chat' ? <MessageExtraActionButtons actions={extraActions} /> : null}
        </>
    );
});
