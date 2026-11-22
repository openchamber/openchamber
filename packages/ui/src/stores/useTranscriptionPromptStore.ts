import { create } from 'zustand';

import { getRuntimeKey } from '@/lib/runtime-switch';

export const STT_PROMPT_MAX_LENGTH = 4096;

type TranscriptionPromptState = {
    sttPrompt: string;
    runtimeKey: string | null;
};

export const useTranscriptionPromptStore = create<TranscriptionPromptState>()(() => ({ sttPrompt: '', runtimeKey: null }));

export const selectTranscriptionPrompt = (state: TranscriptionPromptState): string => (
    state.runtimeKey === getRuntimeKey() ? state.sttPrompt : ''
);

export const readTranscriptionPrompt = (): string => selectTranscriptionPrompt(useTranscriptionPromptStore.getState());

export const setTranscriptionPrompt = (sttPrompt: string): void => {
    useTranscriptionPromptStore.setState({ sttPrompt, runtimeKey: getRuntimeKey() });
};
