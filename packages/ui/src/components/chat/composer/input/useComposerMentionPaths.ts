import React from 'react';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { toProjectRelativeMentionPath } from '../../composer/attachments/filePaths';



export function useComposerMentionPaths() {
    const chatSearchDirectory = useChatSearchDirectory();
    // Mention paths are shown relative to the project the chat searches.
    const toMentionPath = React.useCallback(
        (absolutePath: string) => toProjectRelativeMentionPath(absolutePath, chatSearchDirectory || ""),
        [chatSearchDirectory],
    );

    return {
        chatSearchDirectory, toMentionPath,
    };
}
