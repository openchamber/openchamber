import React from 'react';

import type { ToolPopupContent } from '@/components/chat/message/types';
import { useUIStore } from '@/stores/useUIStore';

type MarkdownRendererToolPopup = {
    popup: ToolPopupContent | null;
    onShowPopup: ((content: ToolPopupContent) => void) | undefined;
    onPopupOpenChange: (open: boolean) => void;
    discardPopup: () => void;
};

export const useMarkdownRendererToolPopup = (enabled: boolean): MarkdownRendererToolPopup => {
    const setImagePreviewOpen = useUIStore((state) => state.setImagePreviewOpen);
    const [popup, setPopup] = React.useState<ToolPopupContent | null>(null);
    const previewOpenRef = React.useRef(false);

    const handleShowPopup = React.useCallback((content: ToolPopupContent) => {
        previewOpenRef.current = true;
        setPopup(content);
        setImagePreviewOpen(true);
    }, [setImagePreviewOpen]);

    const handlePopupOpenChange = React.useCallback((open: boolean) => {
        previewOpenRef.current = open;
        setPopup((prev) => (prev ? { ...prev, open } : prev));
        setImagePreviewOpen(open);
    }, [setImagePreviewOpen]);

    const discardPopup = React.useCallback(() => {
        previewOpenRef.current = false;
        setPopup(null);
        setImagePreviewOpen(false);
    }, [setImagePreviewOpen]);

    React.useEffect(() => () => {
        if (previewOpenRef.current) {
            previewOpenRef.current = false;
            setImagePreviewOpen(false);
        }
    }, [setImagePreviewOpen]);

    return {
        popup: enabled ? popup : null,
        onShowPopup: enabled ? handleShowPopup : undefined,
        onPopupOpenChange: handlePopupOpenChange,
        discardPopup,
    };
};
