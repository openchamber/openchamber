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

  // Home directory is intentionally NOT restored from localStorage here.
  // The persisted value is only a boot-time cache already consumed by the
  // directory store's initial state; replaying it through
  // synchronizeHomeDirectory would persist a possibly stale value back into
  // desktop settings, overriding the authoritative resolution
  // (initializeHomeDirectory → /api/fs/home) that runs on every startup.

  if (savedDirectory && !isVSCodeRuntime()) {
    const runtimeKey = getRuntimeKey();
    const currentDirectory = useDirectoryStore.getState().currentDirectory;
    const availability = await opencodeClient.getDirectoryAvailability(savedDirectory);
    // A saved path is only a startup hint. A probe must not undo a newer
    // navigation, settings snapshot, or host switch while it was in flight.
    if (getRuntimeKey() !== runtimeKey
      || useDirectoryStore.getState().currentDirectory !== currentDirectory
      || window.localStorage.getItem('lastDirectory') !== savedDirectory) return;

    if (availability === 'missing') {
      await useDirectoryStore.getState().goToNoProjectDirectory();
      return;
    }
    // Authentication and transport failures are unknown, so keep the saved
    // choice until the host can confirm that the directory is gone.
    useDirectoryStore.getState().setDirectory(savedDirectory, { showOverlay: false });
  }
};
