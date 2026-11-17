import { useConfigStore } from '../useConfigStore';

export const _agentsLoadErrors = new Map<string, Error>();

export const clearProjectConfigError = (directoryKey: string): void => {
    if (!useConfigStore.getState().projectConfigErrors[directoryKey]) return;
    useConfigStore.setState((state) => {
        const next = { ...state.projectConfigErrors };
        delete next[directoryKey];
        return { projectConfigErrors: next };
    });
};
