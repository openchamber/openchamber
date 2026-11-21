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

    const [attachmentPreviewMounted, setAttachmentPreviewMounted] = React.useState(false);

    React.useEffect(() => {
        if (attachmentPreview.open) {
            setAttachmentPreviewMounted(true);
        }
    }, [attachmentPreview.open]);
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
