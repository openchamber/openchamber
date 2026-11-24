import React from 'react';
import { create } from 'zustand';

const useRequest = create<{ nonce: number; open: boolean }>(() => ({ nonce: 0, open: false }));

export function requestDraftProjectPicker(): void {
    useRequest.setState((state) => ({ nonce: state.nonce + 1 }));
}

export function useDraftProjectPickerOpen(): boolean {
    return useRequest((state) => state.open);
}

export function useAnswerDraftProjectPicker(open: (() => void) | null, isOpen: boolean): void {
    const openRef = React.useRef(open);
    openRef.current = open;
    const answers = open !== null;

    React.useEffect(() => {
        if (!answers) return;
        return useRequest.subscribe((state, previous) => {
            if (state.nonce !== previous.nonce) openRef.current?.();
        });
    }, [answers]);

    React.useEffect(() => {
        if (!answers) return;
        useRequest.setState({ open: isOpen });
        return () => useRequest.setState({ open: false });
    }, [answers, isOpen]);
}
