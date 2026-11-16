import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { assistantTextSegments } from '@/lib/messages/messageText';
import type { Part } from '@/lib/opencode/model';
import type { TurnGroupingContext } from '../../lib/turns/types';
import { saveFile } from '../parts/saveFile';

export const buildTurnMarkdown = (
    earlierAssistantText: TurnGroupingContext['earlierAssistantText'],
    assistantTextParts: Part[],
): string => [...(earlierAssistantText ?? []), ...assistantTextSegments(assistantTextParts)].join('\n\n');

export const buildTurnMarkdownFilename = (messageId: string): string => `message-${messageId}.md`;

export const useAssistantMarkdownSave = ({
    messageId,
    assistantTextParts,
    earlierAssistantText,
}: {
    messageId: string;
    assistantTextParts: Part[];
    earlierAssistantText: TurnGroupingContext['earlierAssistantText'];
}) => {
    const { t } = useI18n();
    // This row draws only part of a long answer: the file holds the whole
    // turn's text, not just what this row shows.
    const saveTurnAsMarkdown = React.useCallback(async () => {
        const text = buildTurnMarkdown(earlierAssistantText, assistantTextParts);
        if (text.length === 0) return;
        await saveFile(new File([text], buildTurnMarkdownFilename(messageId), { type: 'text/markdown' }));
        toast.success(t('chat.messageBody.toast.markdownSaved'));
    }, [assistantTextParts, earlierAssistantText, messageId, t]);

    return { saveTurnAsMarkdown };
};
