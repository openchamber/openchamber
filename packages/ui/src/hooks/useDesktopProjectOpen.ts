import { useEffect } from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { completeDesktopProjectOpen, getPendingDesktopProjectOpens, isDesktopShell } from '@/lib/desktop';
import { updateDesktopSettings } from '@/lib/persistence';
import { getRuntimeApiBaseUrl, getRuntimeKey, subscribeRuntimeEndpointChanged, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

let running: Promise<void> | null = null;
let requested = false;

/** Wait for authoritative local settings, then save the project before opening its new chat draft. */
const processPendingProjects = async (onFailure: () => void): Promise<void> => {
  const pending = await getPendingDesktopProjectOpens();
  if (!pending) return;
  // Recheck the runtime after each async step so an old request cannot write into a newly selected runtime.
  const isCurrentRuntime = () => getRuntimeKey() === 'local'
    && getRuntimeApiBaseUrl().replace(/\/+$/, '') === pending.apiBaseUrl.replace(/\/+$/, '');
  if (!isCurrentRuntime()) {
    switchRuntimeEndpoint({ apiBaseUrl: pending.apiBaseUrl, clientToken: pending.clientToken, runtimeKey: 'local', requestHeaders: null, relay: null });
    return;
  }
  const projects = useProjectsStore.getState();
  if (!projects.hasServerSnapshot || projects.serverSnapshotFailed) return;

  for (const request of pending.requests) {
    if (!isCurrentRuntime()) return;
    try {
      const project = await useProjectsStore.getState().addProject(request.directory);
      if (!isCurrentRuntime()) return;
      if (!project) throw new Error('The directory could not be added as a project.');
      const current = useProjectsStore.getState();
      const saved = await updateDesktopSettings({ projects: current.projects, activeProjectId: project.id });
      if (!isCurrentRuntime()) return;
      if (!saved.ok) throw new Error('The project could not be saved.');
      useUIStore.getState().setSettingsDialogOpen(false);
      useSessionUIStore.getState().openNewSessionDraft({
        selectedProjectId: project.id,
        directoryOverride: project.path,
        target: 'project',
      });
      await completeDesktopProjectOpen(request.id);
    } catch (error) {
      console.warn('[desktop] project open failed', error);
      onFailure();
    }
  }
};

/** Serialize native and initial notifications so Strict Mode or concurrent events cannot open duplicate drafts. */
const runPendingProjects = (onFailure: () => void): Promise<void> => {
  requested = true;
  if (running) return running;
  running = (async () => {
    while (requested) {
      requested = false;
      try { await processPendingProjects(onFailure); }
      catch (error) {
        console.warn('[desktop] failed to read project open requests', error);
        onFailure();
      }
    }
  })().finally(() => { running = null; });
  return running;
};

/** Listen for directory requests outside auth and compatibility checks; web, VS Code, and mobile do not subscribe. */
export const useDesktopProjectOpen = (): void => {
  const { t } = useI18n();
  const connected = useConfigStore((state) => state.isConnected);
  const hasSnapshot = useProjectsStore((state) => state.hasServerSnapshot);
  const snapshotFailed = useProjectsStore((state) => state.serverSnapshotFailed);
  useEffect(() => {
    if (!isDesktopShell()) return;
    const run = () => { void runPendingProjects(() => toast.error(t('directoryExplorerDialog.toast.failedToAddProject'))); };
    window.addEventListener('openchamber:project-open-ready', run);
    const unsubscribe = subscribeRuntimeEndpointChanged(run);
    run();
    return () => {
      window.removeEventListener('openchamber:project-open-ready', run);
      unsubscribe();
    };
  }, [connected, hasSnapshot, snapshotFailed, t]);
};
