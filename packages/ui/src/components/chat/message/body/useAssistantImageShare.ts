import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { assistantTextSegments } from '@/lib/messages/messageText';
import type { Part } from '@/lib/opencode/model';
import type { TurnGroupingContext } from '../../lib/turns/types';
import { buildTurnImageExportSource, resolveMessageImageExportWidth, saveMessageImageExport } from '../imageExport';
import { MessageSliceContext } from '../messageSliceContext';

export const useAssistantImageShare = ({
    messageId,
    messageContentRef,
    messageTextContentRef,
    assistantTextParts,
    earlierAssistantText,
}: {
    messageId: string;
    messageContentRef: React.RefObject<HTMLDivElement | null>;
    messageTextContentRef: React.RefObject<HTMLDivElement | null>;
    assistantTextParts: Part[];
    earlierAssistantText: TurnGroupingContext['earlierAssistantText'];
}) => {
    const { t } = useI18n();
    const theme = useOptionalThemeSystem()?.currentTheme;
    const vscodeApi = useRuntimeAPIs().vscode;
    const slice = React.useContext(MessageSliceContext);
    const shareMessageAsImage = React.useCallback(
        async (requestedSourceElement?: HTMLElement | null) => {
            const sourceElement = requestedSourceElement ?? messageTextContentRef.current ?? messageContentRef.current;
            if (!sourceElement) return;
            try {
                const result = await saveMessageImageExport({
                    source: sourceElement,
                    width: resolveMessageImageExportWidth(messageContentRef.current ?? sourceElement),
                    fileName: `message-${messageId}.png`,
                    vscode: vscodeApi,
                });
                if (result === 'saved') toast.success(t('chat.messageBody.toast.imageSaved'));
            } catch (error) {
                console.error('Failed to generate image:', error);
                toast.error(t('chat.messageBody.toast.generateImageFailed'));
            }
        },
        [messageContentRef, messageId, messageTextContentRef, t, vscodeApi]
    );

    // Re-render every part so folded text and settled highlighting are included.
    const shareTextAsImage = React.useCallback(
        async (segments: string[], requestedSourceElement?: HTMLElement | null) => {
            if (segments.length === 0) {
                await shareMessageAsImage(requestedSourceElement);
                return;
            }
            const syntaxStyle = messageContentRef.current?.querySelector('[data-markdown-content]')?.getAttribute('style') ?? null;
            let turnSource: HTMLElement;
            try {
                turnSource = await buildTurnImageExportSource(segments, syntaxStyle, {
                    width: resolveMessageImageExportWidth(messageContentRef.current),
                    theme,
                });
            } catch (error) {
                console.error('Failed to generate image:', error);
                toast.error(t('chat.messageBody.toast.generateImageFailed'));
                return;
            }
            await shareMessageAsImage(turnSource);
        },
        [messageContentRef, shareMessageAsImage, t, theme]
    );
    const shareTurnAsImage = React.useCallback(
        (requestedSourceElement?: HTMLElement | null) => shareTextAsImage(
            [...(earlierAssistantText ?? []), ...assistantTextSegments(assistantTextParts)],
            requestedSourceElement,
        ),
        [assistantTextParts, earlierAssistantText, shareTextAsImage]
    );
    // This row draws only part of a long answer: the image is made from the
    // message's text, not from what this row shows.
    const shareShownMessageAsImage = React.useCallback(
        (requestedSourceElement?: HTMLElement | null) => (slice
            ? shareTextAsImage(assistantTextSegments(assistantTextParts), requestedSourceElement)
            : shareMessageAsImage(requestedSourceElement)),
        [assistantTextParts, shareMessageAsImage, shareTextAsImage, slice]
    );

    return { shareTurnAsImage, shareShownMessageAsImage };
};
