import React from 'react';

import { hasOpenDropdown } from '@/hooks/keyboard-shortcut-dom';

type ImagePreviewKeyboardOptions = {
    open: boolean;
    annotating: boolean;
    setAnnotating: React.Dispatch<React.SetStateAction<boolean>>;
    onOpenChange: (open: boolean) => void;
    direction: 'ltr' | 'rtl';
    hasMultipleImages: boolean;
    showPrevious: () => void;
    showNext: () => void;
};

export function useImagePreviewKeyboard({
    open,
    annotating,
    setAnnotating,
    onOpenChange,
    direction,
    hasMultipleImages,
    showPrevious,
    showNext,
}: ImagePreviewKeyboardOptions): void {
    React.useEffect(() => {
        if (!open) return;

        const onKeyDown = (event: KeyboardEvent) => {
            if (hasOpenDropdown()) return;
            if (event.key === 'Escape') {
                if (annotating) {
                    setAnnotating(false);
                    return;
                }
                onOpenChange(false);
                return;
            }
            if (annotating) return;

            const previousKey = direction === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
            const nextKey = direction === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
            if (event.key === previousKey && hasMultipleImages) {
                event.preventDefault();
                showPrevious();
                return;
            }

            if (event.key === nextKey && hasMultipleImages) {
                event.preventDefault();
                showNext();
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => {
            window.removeEventListener('keydown', onKeyDown);
        };
    }, [annotating, direction, hasMultipleImages, onOpenChange, open, setAnnotating, showNext, showPrevious]);
}