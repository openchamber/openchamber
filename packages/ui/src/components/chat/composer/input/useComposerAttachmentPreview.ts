import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolPopupContent } from '../../message/types';



export function useComposerAttachmentPreview() {
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const [attachmentPreview, setAttachmentPreview] = React.useState<ToolPopupContent>({
        open: false,
        title: '',
        content: '',
    });

    // Mount the lazy preview dialog only after its first open; rendering it
    // closed would fetch the ToolOutputDialog chunk (with the @pierre/diffs
    // stack) on the draft screen before any preview is requested.
    const [attachmentPreviewMounted, setAttachmentPreviewMounted] = React.useState(false);

    React.useEffect(() => {
        if (attachmentPreview.open) {
            setAttachmentPreviewMounted(true);
        }
    }, [attachmentPreview.open]);
    // An image opens the image viewer, a text file (a pasted text, a JSON
    // file) the text dialog, as the same chip in a sent message does.
    const handleShowAttachmentPreview = React.useCallback((content: ToolPopupContent) => {
        setAttachmentPreview(content);
        setImagePreviewOpen(true);
    }, [setImagePreviewOpen]);

    const handleAttachmentPreviewOpenChange = React.useCallback((open: boolean) => {
        setAttachmentPreview((prev) => ({ ...prev, open }));
        setImagePreviewOpen(open);
    }, [setImagePreviewOpen]);

    return {
    attachmentPreview, attachmentPreviewMounted, handleShowAttachmentPreview,
    handleAttachmentPreviewOpenChange,
    };
}
