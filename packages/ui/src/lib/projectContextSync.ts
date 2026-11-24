import { isServerOffline } from '@/lib/server-offline';
import { subscribeOpenchamberEvents } from './openchamberEvents';
import { resolveProjectContextId, type ProjectRef } from './projectContextApi';
import { getRuntimeKey } from './runtime-switch';
import { useProjectContextStore } from '@/stores/useProjectContextStore';

export const observeProjectContext = (
  project: ProjectRef,
  read: () => Promise<void> = () => useProjectContextStore.getState().load(project, { force: true }),
): (() => void) => {
  const projectId = resolveProjectContextId(project);
  if (!projectId) return () => {};
  const runtimeKey = getRuntimeKey();
  let stopped = false;
  let queued = false;
  let refreshing = false;
  let dirty = false;
  const active = () => (
    !stopped && runtimeKey === getRuntimeKey()
    && document.visibilityState !== 'hidden' && !isServerOffline()
  );
  const refresh = (): void => {
    dirty = true;
    if (!active() || queued || refreshing) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!active()) return;
      dirty = false;
      refreshing = true;
      void read().finally(() => {
        refreshing = false;
        if (dirty) refresh();
      });
    });
  };

  const releaseEvents = subscribeOpenchamberEvents(event => {
    if ((event.type === 'project-context-changed' && event.projectId === projectId)
      || event.type === 'event-stream-ready') refresh();
  });
  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', refresh);
  refresh();

  return () => {
    stopped = true;
    releaseEvents();
    window.removeEventListener('focus', refresh);
    window.removeEventListener('online', refresh);
    document.removeEventListener('visibilitychange', refresh);
  };
};
