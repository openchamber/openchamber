import React from 'react';



export function useComposerDropState() {
    const [isDragging, setIsDragging] = React.useState(false);

    const [isInternalDrag, setIsInternalDrag] = React.useState(false);
    const dropZoneRef = React.useRef<HTMLDivElement>(null);

    const dragEnterCountRef = React.useRef(0);

    const suppressNextFileDropTextInsertRef = React.useRef(false);

    const suppressNextFileDropTextInsertTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    const suppressNextFileMentionPasteRef = React.useRef(false);

    const suppressNextFileMentionPasteTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const pendingDroppedAbsolutePathsRef = React.useRef<string[]>([]);

    return {
    isDragging, setIsDragging, isInternalDrag, setIsInternalDrag, dropZoneRef, dragEnterCountRef,
    suppressNextFileDropTextInsertRef, suppressNextFileDropTextInsertTimeoutRef,
    suppressNextFileMentionPasteRef, suppressNextFileMentionPasteTimeoutRef,
    pendingDroppedAbsolutePathsRef,
    };
}
