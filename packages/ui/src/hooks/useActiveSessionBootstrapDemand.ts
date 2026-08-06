import React from 'react';

import { normalizePath } from '@/lib/pathNormalization';
import type { ChildStoreManager } from '@/sync/child-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { resyncBlockingRequestsForDirectory } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';

/**
 * Revalidates the selected session's blocking requests.
 *
 * The sync provider bootstraps the current directory itself (`SyncProvider`
 * ensures the child store with `reason: "current-directory"`, and
 * `bootstrapDirectory` fetches pending questions/permissions), but it does
 * NOT re-check the selected session once the directory is already `complete`.
 * `resyncBlockingRequestsForDirectory` is documented as
 * reconnect/materialization only, and normal session switches rely purely on
 * the SSE reducer. A `question.asked` / `permission.asked` event missed
 * during a disconnect therefore stays missing, and the user sees a question
 * card that cannot be answered ("This question is no longer waiting for a
 * response"). The same gap appears when a second tab, window, or device
 * opens after the request was asked.
 *
 * This hook closes that gap by revalidating on session selection, focus,
 * visibility-return, and `pageshow`.
 *
 * Directory note: `currentSessionDirectory` may briefly be a guess while the
 * session's owning worktree is unknown.
 * `adoptAuthoritativeSessionDirectory()` runs once bootstrap completes, which
 * updates the store and re-runs this effect with the confirmed directory. A
 * revalidation that fires against the guessed directory is a wasted fetch, not
 * a corrupting one - the signature guard in
 * `resyncBlockingRequestsForDirectory` refuses to overwrite live SSE state.
 */

type BlockingRequestResync = (
  directory: string,
  store: ReturnType<ChildStoreManager['ensureChild']>,
  candidateSessionIds: string[],
) => Promise<void>;

type RevalidationEventTarget = {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

type RevalidationDocumentTarget = RevalidationEventTarget & {
  visibilityState: string;
};

const activeBlockingRequestRevalidations = new WeakMap<ChildStoreManager, Map<string, Promise<void>>>();

function revalidateSelectedSessionBlockingRequests(input: {
  childStores: ChildStoreManager;
  directory: string;
  sessionId: string;
  resync: BlockingRequestResync;
}): Promise<void> {
  const { childStores, directory, sessionId, resync } = input;
  const key = `${directory}\u0000${sessionId}`;
  let active = activeBlockingRequestRevalidations.get(childStores);
  if (!active) {
    active = new Map();
    activeBlockingRequestRevalidations.set(childStores, active);
  }

  const existing = active.get(key);
  if (existing) return existing;

  const store = childStores.getChild(directory) ?? childStores.ensureChild(directory, { bootstrap: false });
  const request = Promise.resolve()
    .then(() => resync(directory, store, [sessionId]))
    .finally(() => {
      if (active?.get(key) !== request) return;
      active.delete(key);
      if (active.size === 0) activeBlockingRequestRevalidations.delete(childStores);
    });
  active.set(key, request);
  return request;
}

export function createActiveSessionBlockingRequestRevalidator(input: {
  childStores: ChildStoreManager;
  directory: string;
  sessionId: string;
  resync?: BlockingRequestResync;
  documentTarget?: RevalidationDocumentTarget | null;
  windowTarget?: RevalidationEventTarget | null;
}): () => void {
  const directory = normalizePath(input.directory);
  const sessionId = input.sessionId.trim();
  if (!directory || !sessionId) return () => undefined;

  const { childStores } = input;
  const resync = input.resync ?? resyncBlockingRequestsForDirectory;
  const documentTarget = input.documentTarget
    ?? (typeof document === 'undefined' ? null : document);
  const windowTarget = input.windowTarget
    ?? (typeof window === 'undefined' ? null : window);
  let disposed = false;
  let unsubscribeBootstrap: (() => void) | null = null;

  childStores.ensureChild(directory, { bootstrap: false });

  const stopWaitingForBootstrap = (): void => {
    unsubscribeBootstrap?.();
    unsubscribeBootstrap = null;
  };

  const requestRevalidation = (): void => {
    if (disposed) return;
    if (childStores.getBootstrapState(directory) !== 'complete') {
      if (!unsubscribeBootstrap) {
        unsubscribeBootstrap = childStores.subscribeBootstrap(() => {
          if (disposed || childStores.getBootstrapState(directory) !== 'complete') return;
          stopWaitingForBootstrap();
          requestRevalidation();
        });
        if (childStores.getBootstrapState(directory) === 'complete') {
          stopWaitingForBootstrap();
          requestRevalidation();
        }
      }
      return;
    }

    stopWaitingForBootstrap();
    void revalidateSelectedSessionBlockingRequests({ childStores, directory, sessionId, resync }).catch(() => undefined);
  };

  const handleVisibilityChange = (): void => {
    if (documentTarget?.visibilityState === 'visible') requestRevalidation();
  };
  const handleSurfaceReturn = (): void => requestRevalidation();

  documentTarget?.addEventListener('visibilitychange', handleVisibilityChange);
  windowTarget?.addEventListener('focus', handleSurfaceReturn);
  windowTarget?.addEventListener('pageshow', handleSurfaceReturn);
  requestRevalidation();

  return () => {
    disposed = true;
    stopWaitingForBootstrap();
    documentTarget?.removeEventListener('visibilitychange', handleVisibilityChange);
    windowTarget?.removeEventListener('focus', handleSurfaceReturn);
    windowTarget?.removeEventListener('pageshow', handleSurfaceReturn);
  };
}

export function useActiveSessionBootstrapDemand(): void {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = normalizePath(
    useSessionUIStore((state) => state.currentSessionDirectory) ?? null,
  );

  React.useEffect(() => {
    if (!currentSessionId || !currentSessionDirectory) return;

    let stores: ReturnType<typeof getSyncChildStores> | null = null;
    try {
      stores = getSyncChildStores();
    } catch {
      return;
    }
    if (!stores) return;

    return createActiveSessionBlockingRequestRevalidator({
      childStores: stores,
      directory: currentSessionDirectory,
      sessionId: currentSessionId,
    });
  }, [currentSessionDirectory, currentSessionId]);
}
