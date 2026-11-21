import React from 'react';
import { useChatSearchDirectory } from '@/hooks/useChatSearchDirectory';
import { toProjectRelativeMentionPath } from '../../composer/attachments/filePaths';



export function useComposerMentionPaths() {
    const chatSearchDirectory = useChatSearchDirectory();
    const toMentionPath = React.useCallback(
        (absolutePath: string) => toProjectRelativeMentionPath(absolutePath, chatSearchDirectory || ""),
        [chatSearchDirectory],
    );

    return {
        chatSearchDirectory, toMentionPath,
    };
}
