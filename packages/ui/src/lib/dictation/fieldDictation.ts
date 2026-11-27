import { useEffect } from 'react';
import { flushSync } from 'react-dom';
import { create } from 'zustand';

import type { UseDictationResult } from '@/hooks/useDictation';

interface FieldRecordingTarget {
    fieldKey: string;
    panelKey: string;
    insert: (text: string) => void | Promise<void>;
}

export type FieldRecordingView = Pick<UseDictationResult, 'status' | 'duration' | 'error' | 'errorReason' | 'partialTranscript'>;

export type FieldRecordingActions = Pick<UseDictationResult,
    'startDictation' | 'confirmDictation' | 'cancelDictation' | 'retryFailedDictation'
    | 'acceptPartialTranscript' | 'discardFailedDictation' | 'subscribeLevel'>;

export interface DictationStatusActions {
    finish: () => void;
    cancel: () => void;
    retry: () => void;
    discard: () => void;
    acceptPartial: () => void;
    subscribeLevel: FieldRecordingActions['subscribeLevel'];
}

export interface FieldRecording extends FieldRecordingTarget {
    id: number;
    view: FieldRecordingView;
    actions: FieldRecordingActions | null;
}

const INITIAL_VIEW: FieldRecordingView = { status: 'idle', duration: 0, error: null, errorReason: null, partialTranscript: '' };

let nextRecordingId = 1;
const openPanels = new Map<string, number>();

export const useFieldDictationStore = create<{ recordings: readonly FieldRecording[]; deliveries: number }>(() => ({ recordings: [], deliveries: 0 }));

export const deliverFieldText = async (insert: FieldRecordingTarget['insert'], text: string): Promise<void> => {
    useFieldDictationStore.setState(({ deliveries }) => ({ deliveries: deliveries + 1 }));
    try {
        await insert(text);
    } finally {
        useFieldDictationStore.setState(({ deliveries }) => ({ deliveries: deliveries - 1 }));
    }
};

const windowClose = { pending: false };

export const isWindowClosePending = (): boolean => windowClose.pending;

export const setWindowClosePending = (pending: boolean): void => {
    windowClose.pending = pending;
};

export const browserPanelKey = (directory: string, tabID: string): string => `browser:${directory}:${tabID}`;

const patchRecording = (id: number, patch: Partial<Pick<FieldRecording, 'view' | 'actions'>>): void => {
    useFieldDictationStore.setState(({ recordings }) => ({
        recordings: recordings.map((recording) => (recording.id === id ? { ...recording, ...patch } : recording)),
    }));
};

export const publishFieldRecording = (id: number, view: FieldRecordingView): void => patchRecording(id, { view });

export const attachFieldRecording = (id: number, actions: FieldRecordingActions): void => patchRecording(id, { actions });

export const removeFieldRecording = (id: number): void => {
    useFieldDictationStore.setState(({ recordings }) => ({ recordings: recordings.filter((recording) => recording.id !== id) }));
};

const recordingOf = (recordings: readonly FieldRecording[], fieldKey: string): FieldRecording | undefined => (
    recordings.filter((recording) => recording.fieldKey === fieldKey).at(-1)
);

export const useFieldRecording = (fieldKey: string): FieldRecording | undefined => (
    useFieldDictationStore((state) => recordingOf(state.recordings, fieldKey))
);

const finishWhere = (matches: (recording: FieldRecording) => boolean): void => {
    for (const recording of useFieldDictationStore.getState().recordings) {
        if (recording.view.status === 'recording' && matches(recording)) void recording.actions?.confirmDictation();
    }
};

export const startFieldDictation = (target: FieldRecordingTarget): void => {
    const current = recordingOf(useFieldDictationStore.getState().recordings, target.fieldKey);
    if (current && current.view.status !== 'failed') return;
    finishAllFieldDictations();
    const id = nextRecordingId++;
    flushSync(() => useFieldDictationStore.setState(({ recordings }) => ({
        recordings: [...recordings, { ...target, id, view: INITIAL_VIEW, actions: null }],
    })));
    const started = useFieldDictationStore.getState().recordings.find((recording) => recording.id === id);
    if (!started?.actions) {
        removeFieldRecording(id);
        return;
    }
    void started.actions.startDictation();
};

export const finishFieldDictation = (fieldKey: string): void => finishWhere((recording) => recording.fieldKey === fieldKey);

export const finishAllFieldDictations = (): void => finishWhere(() => true);

export const discardFieldDictations = (fieldKey: string): void => {
    for (const { fieldKey: key, view, actions } of useFieldDictationStore.getState().recordings) {
        if (key !== fieldKey) continue;
        if (view.status === 'failed') actions?.discardFailedDictation();
        else void actions?.cancelDictation();
    }
};

export const hasActiveFieldDictation = (fieldKey: string): boolean => useFieldDictationStore.getState().recordings
    .some((recording) => recording.fieldKey === fieldKey && recording.view.status === 'recording');

export const fieldDictationsEnded = (fieldKey: string): Promise<void> => new Promise((resolve) => {
    const running = () => useFieldDictationStore.getState().recordings.some(({ fieldKey: key, view }) => (
        key === fieldKey && (view.status === 'recording' || view.status === 'uploading')
    ));
    if (!running()) {
        resolve();
        return;
    }
    const unsubscribe = useFieldDictationStore.subscribe(() => {
        if (running()) return;
        unsubscribe();
        resolve();
    });
});

export const cancelFieldDictation = (fieldKey: string): void => {
    const active = useFieldDictationStore.getState().recordings
        .find((recording) => recording.fieldKey === fieldKey && recording.view.status !== 'failed');
    if (active) void active.actions?.cancelDictation();
    else discardFieldDictations(fieldKey);
};

const holdPanelOpen = (panelKey: string): (() => void) => {
    openPanels.set(panelKey, (openPanels.get(panelKey) ?? 0) + 1);
    return () => {
        const holders = (openPanels.get(panelKey) ?? 1) - 1;
        if (holders > 0) {
            openPanels.set(panelKey, holders);
            return;
        }
        openPanels.delete(panelKey);
        queueMicrotask(() => {
            if (!openPanels.has(panelKey)) finishWhere((recording) => recording.panelKey === panelKey);
        });
    };
};

export const useFieldPanelOpen = (panelKey: string | null, open: boolean): void => {
    useEffect(() => (panelKey !== null && open ? holdPanelOpen(panelKey) : undefined), [open, panelKey]);
};
