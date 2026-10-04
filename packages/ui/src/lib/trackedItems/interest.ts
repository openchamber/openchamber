import React from 'react';
import { z } from 'zod';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useTrackedItemsStore } from '@/stores/useTrackedItemsStore';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { trackedItemKey, trackedItemRecordsSchema, type TrackedItem, type TrackedItemState } from './model';

/**
 * What this client shows, told to the server once per change.
 *
 * Every surface that shows linked items declares them; the union goes to the
 * server for this event-stream connection, debounced, only when it changed
 * (an emptied set too: the stream stays open for other listeners), and again
 * after a reconnect, since a new connection knows nothing. Changes come back
 * as `tracked-items-changed` events. Whether the window is visible is told
 * when it flips. Nothing here runs on a timer.
 */

const FLUSH_DELAY_MS = 150;
// A failed send is retried once the server may be back; a change or a new
// connection sends sooner.
const RETRY_DELAY_MS = 30_000;

const interestResponseSchema = z.object({ states: z.unknown() });

type StreamEvent =
  | { type: 'event-stream-ready'; connectionId: string | null }
  | { type: 'tracked-items-changed'; records: Array<{ key: string; record: TrackedItemState }> }
  | { type: 'source-control-activity'; directory: string }
  | { type: string };

type InterestRequest = { path: '/api/tracked-items/interest'; body: { connectionId: string; visible: boolean; items: TrackedItem[] } };
type PresenceRequest = { path: '/api/tracked-items/presence'; body: { connectionId: string; visible: boolean } };

type Dependencies = {
  subscribe: (listener: (event: StreamEvent) => void) => void;
  post: (request: InterestRequest | PresenceRequest) => Promise<Response>;
  apply: (records: Array<{ key: string; record: TrackedItemState }>) => void;
  isVisible: () => boolean;
  onVisibilityChange: (listener: () => void) => void;
  /** An agent turn finished in a directory: branches there may have a new pull request. */
  onBranchActivity?: (directory: string) => void;
  /** The window became visible again. */
  onWindowReturned?: () => void;
  warn?: (message: string) => void;
};

export function createTrackedItemsInterest({
  subscribe,
  post,
  apply,
  isVisible,
  onVisibilityChange,
  onBranchActivity = () => {},
  onWindowReturned = () => {},
  warn = () => {},
}: Dependencies) {
  const declarations = new Map<symbol, readonly TrackedItem[]>();
  let connectionId: string | null = null;
  let sentSignature: string | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let generation = 0;

  const union = () => {
    const items = new Map<string, TrackedItem>();
    for (const declared of declarations.values()) for (const item of declared) items.set(trackedItemKey(item), item);
    return items;
  };

  const scheduleFlush = (delayMs = FLUSH_DELAY_MS) => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delayMs);
  };

  const flush = async () => {
    const connection = connectionId;
    if (!connection) return;
    const items = union();
    const signature = [...items.keys()].sort().join('\n');
    if (signature === sentSignature) return;
    const requestGeneration = generation;
    try {
      const response = await post({ path: '/api/tracked-items/interest', body: { connectionId: connection, visible: isVisible(), items: [...items.values()] } });
      if (requestGeneration !== generation) return;
      // The connection closed before the server saw it; the next one resends.
      if (response.status === 409) return;
      if (!response.ok) throw new Error(`Tracked items returned ${response.status}`);
      const parsed = interestResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('Tracked items answered without states');
      sentSignature = signature;
      apply(trackedItemRecordsSchema.parse(parsed.data.states));
    } catch (error) {
      if (requestGeneration !== generation) return;
      warn(`[tracked-items] could not tell the server what is shown: ${String(error)}`);
      scheduleFlush(RETRY_DELAY_MS);
    }
  };

  const start = () => {
    if (started) return;
    started = true;
    subscribe((event) => {
      if (event.type === 'event-stream-ready' && 'connectionId' in event) {
        generation += 1;
        connectionId = event.connectionId;
        sentSignature = null;
        scheduleFlush(0);
        return;
      }
      if (event.type === 'tracked-items-changed' && 'records' in event) apply(event.records);
      if (event.type === 'source-control-activity' && 'directory' in event) onBranchActivity(event.directory);
    });
    onVisibilityChange(() => {
      if (isVisible()) onWindowReturned();
      const connection = connectionId;
      if (!connection || sentSignature === null) return;
      // A lost presence signal costs one cadence: the next interest send carries visibility too.
      post({ path: '/api/tracked-items/presence', body: { connectionId: connection, visible: isVisible() } }).catch(() => {});
    });
  };

  return {
    /** Starts listening without following anything yet, so signals reach watched branches. */
    start,
    declare(token: symbol, items: readonly TrackedItem[]) {
      declarations.set(token, items);
      start();
      scheduleFlush();
    },
    release(token: symbol) {
      declarations.delete(token);
      scheduleFlush();
    },
  };
}

const trackedItemsInterest = createTrackedItemsInterest({
  subscribe: (listener) => { subscribeOpenchamberEvents(listener); },
  post: ({ path, body }) => runtimeFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }),
  // The runtime is read when the answer lands: records belong to the runtime
  // that sent them. A branch's open pull request also lands on its entry.
  apply: (records) => {
    useTrackedItemsStore.getState().apply(getRuntimeKey(), records);
    useGitHubPrStatusStore.getState().applyTrackedPulls(records);
  },
  isVisible: () => document.visibilityState !== 'hidden',
  onVisibilityChange: (listener) => document.addEventListener('visibilitychange', listener),
  onBranchActivity: (directory) => useGitHubPrStatusStore.getState().noteBranchActivity(directory),
  onWindowReturned: () => useGitHubPrStatusStore.getState().noteWindowReturned(),
  warn: (message) => console.warn(message),
});

/**
 * Follows these items while the calling component is mounted. The server
 * starts answering at once and pushes changes; read them with the
 * `useTracked*States` selectors.
 */
export function useTrackedItems(items: readonly TrackedItem[]): void {
  const signature = items.map(trackedItemKey).sort().join('\n');
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  React.useEffect(() => {
    trackedItemsInterest.start();
    if (!signature) return undefined;
    const token = Symbol('tracked-items');
    trackedItemsInterest.declare(token, itemsRef.current);
    return () => trackedItemsInterest.release(token);
  }, [signature]);
}
