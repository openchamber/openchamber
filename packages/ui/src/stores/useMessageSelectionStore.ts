import { create } from 'zustand';

type MessageSelectionUnitKind = 'prompt' | 'answer';

export const messageSelectionKey = (kind: MessageSelectionUnitKind, turnId: string): string => `${kind}:${turnId}`;

type MessageSelection = {
    id: number;
    sessionId: string;
    keys: ReadonlySet<string>;
    anchor: string;
};

type MessageSelectionState = {
    selection: MessageSelection | null;
    begin: (sessionId: string, key: string) => void;
    toggle: (sessionId: string, key: string) => void;
    selectRange: (sessionId: string, key: string, orderedKeys: readonly string[]) => void;
    retain: (selectionId: number, keys: ReadonlySet<string>) => void;
    end: (sessionId?: string) => void;
    endSelection: (selectionId: number) => void;
};

let nextSelectionId = 1;

export const useMessageSelectionStore = create<MessageSelectionState>()((set) => ({
    selection: null,
    begin: (sessionId, key) => set({ selection: { id: nextSelectionId++, sessionId, keys: new Set([key]), anchor: key } }),
    toggle: (sessionId, key) => set(({ selection }) => {
        if (selection?.sessionId !== sessionId) return {};
        const keys = new Set(selection.keys);
        if (keys.has(key)) keys.delete(key);
        else keys.add(key);
        return { selection: { ...selection, keys, anchor: key } };
    }),
    selectRange: (sessionId, key, orderedKeys) => set(({ selection }) => {
        if (selection?.sessionId !== sessionId) return {};
        const from = orderedKeys.indexOf(selection.anchor);
        const to = orderedKeys.indexOf(key);
        if (from < 0 || to < 0) {
            const keys = new Set(selection.keys).add(key);
            return { selection: { ...selection, keys, anchor: key } };
        }
        const keys = new Set(selection.keys);
        for (const rangeKey of orderedKeys.slice(Math.min(from, to), Math.max(from, to) + 1)) keys.add(rangeKey);
        return { selection: { ...selection, keys } };
    }),
    retain: (selectionId, keys) => set(({ selection }) => {
        if (selection?.id !== selectionId) return {};
        return { selection: { ...selection, keys: new Set([...selection.keys].filter((key) => keys.has(key))) } };
    }),
    end: (sessionId) => set(({ selection }) => (
        selection && (sessionId === undefined || selection.sessionId === sessionId) ? { selection: null } : {}
    )),
    endSelection: (selectionId) => set(({ selection }) => (selection?.id === selectionId ? { selection: null } : {})),
}));

const NO_KEYS: ReadonlySet<string> = new Set();

export const useMessageSelectionKeys = (sessionId: string | null | undefined): ReadonlySet<string> => (
    useMessageSelectionStore((state) => (sessionId && state.selection?.sessionId === sessionId ? state.selection.keys : NO_KEYS))
);

export const useMessageSelecting = (sessionId: string | null | undefined): boolean => (
    useMessageSelectionStore((state) => Boolean(sessionId) && state.selection?.sessionId === sessionId)
);

export const useMessageUnitSelected = (sessionId: string | null | undefined, key: string | null): boolean | null => (
    useMessageSelectionStore((state) => {
        if (!key || !sessionId || state.selection?.sessionId !== sessionId) return null;
        return state.selection.keys.has(key);
    })
);
