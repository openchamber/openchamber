import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { isRightToLeft } from '@/lib/i18n';

const FILE_TREE_MIN_WIDTH = 160;
const FILE_TREE_MAX_FRACTION = 0.5;

export function useDiffViewTreeLayout() {
    const storedFileTreeWidth = useUIStore((state) => state.diffFileTreeWidth);
    const setStoredFileTreeWidth = useUIStore((state) => state.setDiffFileTreeWidth);
    const fileTreeLayoutRef = React.useRef<HTMLDivElement | null>(null);
    const [draggingFileTree, setDraggingFileTree] = React.useState(false);
    const fileTreeWidth = Math.max(storedFileTreeWidth, FILE_TREE_MIN_WIDTH);

    const clampFileTreeWidth = React.useCallback((width: number) => {
        const maxWidth = Math.max(FILE_TREE_MIN_WIDTH, (fileTreeLayoutRef.current?.clientWidth ?? 0) * FILE_TREE_MAX_FRACTION);
        return Math.min(maxWidth, Math.max(FILE_TREE_MIN_WIDTH, width));
    }, []);

    const handleFileTreeResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = fileTreeWidth;
        const sign = isRightToLeft(event.currentTarget) ? -1 : 1;
        setDraggingFileTree(true);
        const onMove = (moveEvent: PointerEvent) => {
            setStoredFileTreeWidth(clampFileTreeWidth(startWidth + (moveEvent.clientX - startX) * sign));
        };
        const onUp = () => {
            setDraggingFileTree(false);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        window.addEventListener('pointercancel', onUp);
    }, [clampFileTreeWidth, fileTreeWidth, setStoredFileTreeWidth]);

    const handleFileTreeResizeKey = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        const step = event.shiftKey ? 40 : 10;
        const sign = isRightToLeft(event.currentTarget) ? -1 : 1;
        const delta = (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0) * sign;
        if (delta === 0) return;
        event.preventDefault();
        setStoredFileTreeWidth(clampFileTreeWidth(fileTreeWidth + delta));
    }, [clampFileTreeWidth, fileTreeWidth, setStoredFileTreeWidth]);

    return { fileTreeLayoutRef, draggingFileTree, fileTreeWidth, handleFileTreeResizeStart, handleFileTreeResizeKey };
}
