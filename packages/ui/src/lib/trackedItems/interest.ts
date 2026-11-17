import React from 'react';
import { z } from 'zod';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useTrackedItemsStore } from '@/stores/useTrackedItemsStore';
import { useGitHubPrStatusStore } from '@/stores/useGitHubPrStatusStore';
import { trackedItemKey, trackedItemRecordsSchema, type TrackedItem, type TrackedItemState } from './model';


const FLUSH_DELAY_MS = 150;
const MAX_ITEMS = 300;
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
  onBranchActivity?: (directory: string) => void;
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
  const declarations = new Map<symbol, { items: readonly TrackedItem[]; background: boolean }>();
  let connectionId: string | null = null;
  let sentSignature: string | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let generation = 0;

  const union = () => {
    const items = new Map<string, TrackedItem>();
    const ordered = [...declarations.values()].sort((left, right) => Number(left.background) - Number(right.background));
    for (const declared of ordered) {
      for (const item of declared.items) {
        if (items.size >= MAX_ITEMS) return items;
        items.set(trackedItemKey(item), item);
      }
    }
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
      post({ path: '/api/tracked-items/presence', body: { connectionId: connection, visible: isVisible() } }).catch(() => {});
    });
  };

  return {
    start,
    declare(token: symbol, items: readonly TrackedItem[], options?: { background?: boolean }) {
      declarations.set(token, { items, background: options?.background ?? false });
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

export function useTrackedItems(items: readonly TrackedItem[], options?: {
  background?: boolean;
}): void {
  const background = options?.background ?? false;
  const signature = items.map(trackedItemKey).sort().join('\n');
  const itemsRef = React.useRef(items);
  itemsRef.current = items;
  const [token] = React.useState(() => Symbol('tracked-items'));
  React.useEffect(() => () => trackedItemsInterest.release(token), [token]);
  React.useEffect(() => {
    trackedItemsInterest.start();
    trackedItemsInterest.declare(token, signature ? itemsRef.current : [], { background });
  }, [background, signature, token]);
}
