import React from 'react';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export type FooterSheetAction = { id: string; label: string; icon: React.ReactNode; disabled?: boolean; onPointerRow?: true; onSelect: () => void };

type FooterSheetActionsParams = {
    assistantPlanText: string;
    canUseProjectPlanActions: boolean;
    contextPinPending: boolean | undefined;
    contextPinned: boolean | undefined;
    currentProjectRef: unknown;
    extraActions: Array<{ id: string; label: string; icon: React.ReactNode; onSelect: () => void }> | undefined;
    handleForkClick: () => void;
    handleForkFromHere: () => void;
    handleSaveAsPlanClick: () => void;
    hasCopyableText: boolean;
    isFooterTTSPlaying: boolean;
    isMiniChatSurface: boolean;
    isReviewSessionView: boolean;
    onCopyFooter: (() => void | boolean | Promise<void | boolean>) | undefined;
    onCopyLink: (() => void) | undefined;
    onSelectMessages: (() => void) | undefined;
    onToggleContextPin: (() => void) | undefined;
    playFooterTTS: (text: string) => Promise<void> | void;
    reviewTransferAction: { tooltip: string; onClick: () => void | Promise<void> } | undefined;
    shareTurnAsImage: () => Promise<void>;
    showMessageTTSButtons: boolean;
    stopFooterTTS: () => void;
};

export const useFooterSheetActions = ({
    assistantPlanText,
    canUseProjectPlanActions,
    contextPinPending,
    contextPinned,
    currentProjectRef,
    extraActions,
    handleForkClick,
    handleForkFromHere,
    handleSaveAsPlanClick,
    hasCopyableText,
    isFooterTTSPlaying,
    isMiniChatSurface,
    isReviewSessionView,
    onCopyFooter,
    onCopyLink,
    onSelectMessages,
    onToggleContextPin,
    playFooterTTS,
    reviewTransferAction,
    shareTurnAsImage,
    showMessageTTSButtons,
    stopFooterTTS,
}: FooterSheetActionsParams) => {
    const { t } = useI18n();
    return React.useMemo(() => {
        const actions: FooterSheetAction[] = [];
        if (onCopyFooter) {
            actions.push({
                id: 'copy',
                onPointerRow: true,
                label: t('chat.messageBody.actions.copyAnswer'),
                icon: <Icon name="file-copy" className="h-4 w-4" />,
                disabled: !hasCopyableText,
                onSelect: () => {
                    void (async () => {
                        const copied = await onCopyFooter();
                        if (copied !== false) toast.success(t('chat.messageBody.toast.copied'));
                    })();
                },
            });
        }
        if (onCopyLink) {
            actions.push({
                id: 'copy-link',
                label: t('chat.messageBody.actions.copyLink'),
                icon: <Icon name="link" className="h-4 w-4" />,
                onSelect: onCopyLink,
            });
        }
        if (reviewTransferAction && !isMiniChatSurface) {
            actions.push({
                id: 'review-transfer',
                label: reviewTransferAction.tooltip,
                icon: <Icon name="arrow-left-right" className="h-3.5 w-3.5" />,
                disabled: !hasCopyableText,
                onSelect: () => { void reviewTransferAction.onClick(); },
            });
        }
        if (!isMiniChatSurface) {
            actions.push({
                id: 'share-image',
                label: t('chat.messageBody.actions.saveAsImage'),
                icon: <Icon name="image-download" className="h-3.5 w-3.5" />,
                disabled: !hasCopyableText,
                onSelect: () => { void shareTurnAsImage(); },
            });
        }
        if (onSelectMessages) {
            actions.push({
                id: 'select-messages',
                label: t('chat.messageSelection.action'),
                icon: <Icon name="checkbox-multiple" className="h-3.5 w-3.5" />,
                disabled: !hasCopyableText,
                onSelect: onSelectMessages,
            });
        }
        if (!isMiniChatSurface && showMessageTTSButtons && hasCopyableText) {
            actions.push({
                id: 'tts',
                label: isFooterTTSPlaying ? t('chat.messageBody.tts.stopSpeaking') : t('chat.messageBody.tts.readAloud'),
                icon: <Icon name="volume-up" className={cn('h-4 w-4', isFooterTTSPlaying && 'text-[var(--primary-text)]')} />,
                onSelect: () => {
                    if (isFooterTTSPlaying) {
                        stopFooterTTS();
                        return;
                    }
                    if (assistantPlanText.trim()) void playFooterTTS(assistantPlanText);
                },
            });
        }
        if (canUseProjectPlanActions && !isReviewSessionView) {
            actions.push({
                id: 'save-as-plan',
                label: t('chat.messageBody.actions.saveAsPlan'),
                icon: <Icon name="booklet" className="h-3.5 w-3.5" />,
                disabled: !hasCopyableText || !currentProjectRef,
                onSelect: () => { handleSaveAsPlanClick(); },
            });
        }
        if (onToggleContextPin && hasCopyableText) {
            actions.push({
                id: 'pin-context',
                onPointerRow: true,
                label: t(contextPinned ? 'chat.messageBody.actions.unpinContext' : 'chat.messageBody.actions.pinContext'),
                icon: <Icon name={contextPinned ? 'pushpin-2-fill' : 'pushpin-2'} className="h-4 w-4" />,
                disabled: contextPinPending,
                onSelect: () => { onToggleContextPin(); },
            });
        }
        if (!isMiniChatSurface && !isReviewSessionView) {
            actions.push({
                id: 'fork-from-here',
                onPointerRow: true,
                label: t('chat.messageBody.actions.fork'),
                icon: <Icon name="git-branch" className="h-3.5 w-3.5" />,
                onSelect: handleForkFromHere,
            });
            actions.push({
                id: 'fork',
                onPointerRow: true,
                label: t('chat.messageBody.actions.startNewSession'),
                icon: <Icon name="chat-new" className="h-3.5 w-3.5" />,
                onSelect: () => { handleForkClick(); },
            });
        }
        if (!isMiniChatSurface) {
            for (const extra of extraActions ?? []) {
                actions.push({ id: extra.id, label: extra.label, icon: extra.icon, onSelect: extra.onSelect });
            }
        }
        return actions;
    }, [assistantPlanText, canUseProjectPlanActions, contextPinPending, contextPinned, currentProjectRef, extraActions, handleForkClick, handleForkFromHere, handleSaveAsPlanClick, hasCopyableText, isFooterTTSPlaying, isMiniChatSurface, isReviewSessionView, onCopyFooter, onCopyLink, onSelectMessages, onToggleContextPin, playFooterTTS, reviewTransferAction, shareTurnAsImage, showMessageTTSButtons, stopFooterTTS, t]);
};
