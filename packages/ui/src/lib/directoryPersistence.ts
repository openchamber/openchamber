import { isVSCodeRuntime } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

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
    // Restored only if it still resolves on this computer. A directory that has been
    // deleted, lives on a drive that is not attached, or — as workspace-routed sessions
    // once persisted — exists only inside a container, would otherwise be handed to the
    // file tree at every launch, which reports it as missing and offers no way out.
    if (await directoryStillExists(savedDirectory)) {
      useDirectoryStore.getState().setDirectory(savedDirectory, { showOverlay: false });
    } else {
      try {
        window.localStorage.removeItem('lastDirectory');
      } catch {
        // A cleared value is an optimization; failing to clear it changes nothing.
      }
      // Clearing the mirror alone achieves nothing: persisted settings are written back
      // into local storage on every load, so the unusable directory would return at the
      // next launch. The stored setting is the source and has to be cleared with it.
      void updateDesktopSettings({ lastDirectory: '' });
      // The store already took the saved value for its initial state, so clearing storage
      // is not enough — it has to be moved off the directory that does not resolve. The
      // active project is where the operator was working; home is only the last resort.
      const projects = useProjectsStore.getState();
      const activeProject = projects.projects.find((project) => project.id === projects.activeProjectId);
      const replacement = activeProject?.path || useDirectoryStore.getState().homeDirectory;
      if (replacement && replacement !== savedDirectory) {
        useDirectoryStore.getState().setDirectory(replacement, { showOverlay: false });
      }
    }
  }
};

/** Whether the saved directory is a directory this host can actually open. */
const directoryStillExists = async (directory: string): Promise<boolean> => {
  try {
    const runtime = getRegisteredRuntimeAPIs();
    if (!runtime?.files?.listDirectory) return true;
    await runtime.files.listDirectory(directory);
    return true;
  } catch {
    return false;
  }
};
