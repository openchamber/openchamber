import { getRuntimeKey } from '@/lib/runtime-switch';
import { getPinnedSessionKey, isSessionPinnedInMetadata } from '@/lib/sessionPins';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { forgetLegacyPins, getLegacyPins, setPendingPin, useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { setSessionPinned } from './session-actions';

type PinTarget = { directory: string; sessionId: string };

const pinQueues = new Map<string, { tail: Promise<void>; count: number }>();

export function toggleSessionPin(target: PinTarget): Promise<void> {
  const key = getPinnedSessionKey(getRuntimeKey(), target.directory, target.sessionId);
  if (!key) return Promise.resolve();
  return writeSessionPin(key, target, !useSessionPinnedStore.getState().ids.has(key), null);
}

export function setSessionPinList(target: PinTarget, pinned: boolean, list: string | null): Promise<void> {
  const key = getPinnedSessionKey(getRuntimeKey(), target.directory, target.sessionId);
  if (!key) return Promise.resolve();
  return writeSessionPin(key, target, pinned, list);
}

function writeSessionPin(key: string, target: PinTarget, pinned: boolean, list: string | null): Promise<void> {
  setPendingPin(key, pinned);

  const queue = pinQueues.get(key) ?? { tail: Promise.resolve(), count: 0 };
  queue.count += 1;
  pinQueues.set(key, queue);
  const run = queue.tail.then(async () => {
    try {
      await setSessionPinned(target.sessionId, target.directory, pinned, list);
      if (!pinned) forgetLegacyPins([key]);
    } finally {
      queue.count -= 1;
      if (queue.count === 0) {
        pinQueues.delete(key);
        setPendingPin(key, null);
      }
    }
  });
  queue.tail = run.catch(() => undefined);
  return run;
}

const migratingRuntimes = new Set<string>();

async function migrateLegacyPins(): Promise<void> {
  const state = useGlobalSessionsStore.getState();
  if (!state.hasLoaded || state.status !== 'ready') return;
  const runtimeKey = getRuntimeKey();
  const pins = getLegacyPins(runtimeKey);
  if (pins.length === 0 || migratingRuntimes.has(runtimeKey)) return;
  migratingRuntimes.add(runtimeKey);
  try {
    for (const pin of pins) {
      if (getRuntimeKey() !== runtimeKey) return;
      const session = useGlobalSessionsStore.getState().entityById.get(pin.sessionId);
      if (!session || isSessionPinnedInMetadata(session)) {
        forgetLegacyPins([pin.key]);
        continue;
      }
      try {
        if (await setSessionPinned(pin.sessionId, session.directory ?? pin.directory, true)) forgetLegacyPins([pin.key]);
      } catch (error) {
        console.warn('[session-pins] could not move a local pin to the server', error);
      }
    }
  } finally {
    migratingRuntimes.delete(runtimeKey);
  }
}

useGlobalSessionsStore.subscribe((state, previous) => {
  if (state.hasLoaded && state.status === 'ready' && (previous.status !== 'ready' || !previous.hasLoaded)) {
    void migrateLegacyPins();
  }
});
void migrateLegacyPins();
