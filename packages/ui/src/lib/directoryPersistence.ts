import { isVSCodeRuntime } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useDirectoryStore } from '@/stores/useDirectoryStore';

export const applyPersistedDirectoryPreferences = async (): Promise<void> => {
  if (typeof window === 'undefined') {
    return;
  }

  if (getRuntimeKey() !== 'local' || isVSCodeRuntime()) {
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

  if (savedDirectory) {
    useDirectoryStore.getState().setDirectory(savedDirectory, { showOverlay: false });
  }
};
