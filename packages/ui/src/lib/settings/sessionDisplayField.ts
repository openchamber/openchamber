import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';

type SessionDisplayState = ReturnType<typeof useSessionDisplayStore.getState>;

export const sessionDisplayField = <K extends keyof SessionDisplayState>(key: K) => ({
  read: (): SessionDisplayState[K] => useSessionDisplayStore.getState()[key],
  write: (value: SessionDisplayState[K]): void => {
    // SAFETY: a single-key patch built from the key it is typed by.
    useSessionDisplayStore.setState({ [key]: value } as Pick<SessionDisplayState, K>);
  },
  autoSave: false,
});
