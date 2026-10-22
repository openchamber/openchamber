import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { hasActiveSubagent, subscribeGlobalSessionActivity, useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { currentSubagentWaits } from '@/sync/current-session-work';
import { getDirectoryState, subscribeToSyncSessionWork } from '@/sync/sync-refs';
import { normalizePath } from '@/lib/pathNormalization';

/** Only explicit foreground dependencies propagate a child's wait to a parent. */
export const hasMobileScreenAwakeWork = (
  sessionId: string | null,
  activeIds: ReadonlySet<string>,
  blockedIds: readonly string[],
  parentOf: (id: string) => string | undefined,
  waitsFor: (id: string) => readonly string[],
): boolean => {
  if (!sessionId || activeIds.size === 0) return false;
  const blocked = new Set(blockedIds);
  if (blocked.size === 0) return activeIds.has(sessionId) || hasActiveSubagent(sessionId, activeIds, parentOf);
  const dependenciesById = new Map([...activeIds].map((id) => [id, waitsFor(id)]));
  for (let depth = 0; depth < 8; depth += 1) {
    const waiting: string[] = [];
    for (const id of activeIds) {
      if (blocked.has(id)) continue;
      const dependencies = dependenciesById.get(id) ?? [];
      if (dependencies.length === 0 || !dependencies.every((child) => blocked.has(child))) continue;
      waiting.push(id);
    }
    if (waiting.length === 0) break;
    for (const id of waiting) blocked.add(id);
  }
  const working = new Set([...activeIds].filter((id) => !blocked.has(id)));
  return working.has(sessionId) || hasActiveSubagent(sessionId, working, parentOf);
};

/** Owns subscriptions and desired state; the hook supplies the native writer and lifecycle. */
export function subscribeMobileScreenAwake(write: (enabled: boolean) => Promise<void>, onError: () => void) {
  let disposed = false;
  let foreground = document.visibilityState !== 'hidden';
  let desired: boolean | undefined;
  let revision = 0;
  let confirmedIds: Set<string> | null = useConfigStore.getState().isConnected ? null : new Set();
  let workSubscriptions: Array<() => void> = [];
  let workTargets = new Map<string, string>();
  let unsubscribeSessionWork = () => {};
  const stopSessionWork = () => {
    unsubscribeSessionWork();
    unsubscribeSessionWork = () => {};
    workTargets = new Map();
  };
  const apply = (next: boolean) => {
    if (disposed || desired === next) return;
    desired = next;
    const requested = ++revision;
    void write(next).catch(() => {
      if (!disposed && revision === requested) {
        desired = undefined;
        onError();
      }
    });
  };
  const refresh = () => {
    if (disposed) return;
    const mode = useUIStore.getState().mobileScreenAwakeMode;
    if (!foreground || mode === 'off') {
      stopSessionWork();
      return apply(false);
    }
    if (mode === 'always') return apply(true);
    if (!useConfigStore.getState().isConnected || !getRuntimeApiBaseUrl()) {
      stopSessionWork();
      return apply(false);
    }
    const activeIds = useGlobalSessionStatusStore.getState().activeSessionIds;
    if (confirmedIds) for (const id of confirmedIds) if (!activeIds.has(id)) confirmedIds.delete(id);
    const requests = useGlobalBlockingRequestsStore.getState().bySession;
    const blocked = [...requests].filter(([, pending]) => (
      pending.permissions.length || pending.forms.length || pending.pages.length
    )).map(([id]) => id);
    const sessions = useGlobalSessionsStore.getState().entityById;
    const parentOf = (id: string) => sessions.get(id)?.parentID;
    const sessionID = useSessionUIStore.getState().currentSessionId;
    const eligibleIds = confirmedIds ?? activeIds;
    const targets = new Map<string, string>();
    if (sessionID) for (const id of eligibleIds) {
      if (id !== sessionID && !hasActiveSubagent(sessionID, new Set([id]), parentOf)) continue;
      const directory = normalizePath(sessions.get(id)?.directory);
      if (directory) targets.set(id, directory);
    }
    if (targets.size !== workTargets.size || [...targets].some(([id, directory]) => workTargets.get(id) !== directory)) {
      unsubscribeSessionWork();
      workTargets = targets;
      unsubscribeSessionWork = subscribeToSyncSessionWork(targets, refresh);
    }
    apply(hasMobileScreenAwakeWork(
      sessionID,
      eligibleIds,
      blocked,
      parentOf,
      (id) => !workTargets.has(id) || useGlobalSessionStatusStore.getState().statusById.get(id)?.status.type === 'retry'
        ? [] : currentSubagentWaits(getDirectoryState(workTargets.get(id)), id),
    ));
  };
  const watchWork = () => {
    workSubscriptions.forEach((unsubscribe) => unsubscribe());
    stopSessionWork();
    workSubscriptions = useUIStore.getState().mobileScreenAwakeMode === 'working' ? [
      useSessionUIStore.subscribe((state, previous) => { if (state.currentSessionId !== previous.currentSessionId) refresh(); }),
      useGlobalSessionStatusStore.subscribe((state, previous) => {
        if (state.activeSessionIds === previous.activeSessionIds && [...workTargets.keys()].every((id) => (
          state.statusById.get(id)?.status.type === previous.statusById.get(id)?.status.type
        ))) return;
        refresh();
      }),
      subscribeGlobalSessionActivity((ids) => {
        if (!confirmedIds || !useConfigStore.getState().isConnected) return;
        let changed = false;
        for (const id of ids) {
          if (confirmedIds.has(id)) continue;
          confirmedIds.add(id);
          changed = true;
        }
        if (changed) refresh();
      }),
      useGlobalBlockingRequestsStore.subscribe((state, previous) => { if (state.bySession !== previous.bySession) refresh(); }),
      useGlobalSessionsStore.subscribe((state, previous) => { if (state.structure !== previous.structure) refresh(); }),
    ] : [];
    refresh();
  };
  const modeSubscription = useUIStore.subscribe((state, previous) => {
    if (state.mobileScreenAwakeMode !== previous.mobileScreenAwakeMode) watchWork();
  });
  const connectionSubscription = useConfigStore.subscribe((state, previous) => {
    if (state.isConnected === previous.isConnected) return;
    if (!state.isConnected) confirmedIds = new Set();
    refresh();
  });
  const runtimeSubscription = subscribeRuntimeEndpointWillChange(() => {
    confirmedIds = new Set();
    if (useUIStore.getState().mobileScreenAwakeMode === 'working') apply(false);
  });
  watchWork();
  return {
    setForeground(active: boolean) {
      foreground = active;
      refresh();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      modeSubscription();
      connectionSubscription();
      runtimeSubscription();
      unsubscribeSessionWork();
      workSubscriptions.forEach((unsubscribe) => unsubscribe());
      void write(false).catch(onError);
    },
  };
}
