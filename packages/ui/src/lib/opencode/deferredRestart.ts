import {
  usePendingOpenCodeRestartStore,
  type PendingOpenCodeRestartScope,
} from '@/stores/usePendingOpenCodeRestartStore';

export type ConfigMutationPayload = {
  requiresReload?: boolean;
  requiresRestart?: boolean;
  restartDeferred?: boolean;
  requiresManualRestart?: boolean;
  reloadFailed?: boolean;
  message?: string;
  warning?: string;
  reloadDelayMs?: number;
} | null | undefined;

export function isDeferredRestartPayload(payload: ConfigMutationPayload): boolean {
  if (!payload || typeof payload !== 'object') {
    return false;
  }
  if (payload.requiresManualRestart === true) {
    return false;
  }
  return payload.restartDeferred === true || (payload.requiresRestart === true && payload.requiresReload !== true);
}

export function recordDeferredOpenCodeRestart(
  scope: PendingOpenCodeRestartScope,
  options?: { id?: string; label?: string },
): void {
  usePendingOpenCodeRestartStore.getState().recordChange({
    scope,
    id: options?.id,
    label: options?.label,
  });
}

/**
 * If the mutation response deferred the OpenCode restart, record it and return true.
 * Callers should skip immediate refresh overlays when this returns true.
 */
export function noteDeferredRestartFromPayload(
  payload: ConfigMutationPayload,
  scope: PendingOpenCodeRestartScope,
  options?: { id?: string; label?: string },
): boolean {
  if (!isDeferredRestartPayload(payload)) {
    return false;
  }
  recordDeferredOpenCodeRestart(scope, options);
  return true;
}

export async function applyPendingOpenCodeRestart(options?: {
  message?: string;
}): Promise<{ ok: boolean; requiresManualRestart?: boolean }> {
  const store = usePendingOpenCodeRestartStore.getState();
  if (store.isApplying) {
    return { ok: false };
  }

  store.setApplying(true);
  try {
    const { reloadOpenCodeConfiguration } = await import('@/stores/useAgentsStore');
    await reloadOpenCodeConfiguration({
      message: options?.message,
      mode: 'projects',
      scopes: ['all'],
    });
    usePendingOpenCodeRestartStore.getState().clear();
    return { ok: true };
  } catch (error) {
    if ((error as Error & { requiresManualRestart?: boolean })?.requiresManualRestart) {
      // Changes are already on disk; clear the badge after delivering manual-restart guidance.
      usePendingOpenCodeRestartStore.getState().clear();
      return { ok: false, requiresManualRestart: true };
    }
    usePendingOpenCodeRestartStore.getState().setApplying(false);
    throw error;
  }
}
