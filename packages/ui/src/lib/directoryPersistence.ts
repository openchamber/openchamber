import { isVSCodeRuntime } from '@/lib/desktop';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export const applyPersistedDirectoryPreferences = async (): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }

  let savedDirectory: string | null = null;

  try {
    savedDirectory = window.localStorage.getItem('lastDirectory');
  } catch (error) {
    console.warn('Failed to read saved directory preferences:', error);
  }


  if (savedDirectory && !isVSCodeRuntime()) {
    const runtimeKey = getRuntimeKey();
    const currentDirectory = useDirectoryStore.getState().currentDirectory;
    const availability = await opencodeClient.getDirectoryAvailability(savedDirectory);
    if (getRuntimeKey() !== runtimeKey
      || useDirectoryStore.getState().currentDirectory !== currentDirectory
      || window.localStorage.getItem('lastDirectory') !== savedDirectory) return;

    if (availability === 'missing') {
      await useDirectoryStore.getState().goToNoProjectDirectory();
      return;
    }
    useDirectoryStore.getState().setDirectory(savedDirectory, { showOverlay: false });
  }
};
