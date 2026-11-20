import type { createApnsRuntime } from './apns-runtime.js';
import type { JsonValue } from './contracts.js';
import { hasErrorMessage, isJsonObject, isNumber, isString } from './inputs.js';

export interface PushClaim {
  sessionId: string;
  spaceId?: string;
  cause: JsonValue;
  native: boolean;
  nativeNid?: JsonValue;
  nid: JsonValue;
  skipTurnStart?: boolean;
}

interface PushTagsState {
  open: [JsonValue, PushClaim][];
  cleared: [JsonValue, JsonValue][];
}

export interface PushTagsStore {
  read: () => Promise<JsonValue>;
  write: (state: PushTagsState) => Promise<void>;
}

export const OPEN_PUSH_TAGS_LIMIT = 500;
const RECENTLY_CLEARED_TAGS_LIMIT = 20;

export const keepNewest = <Key, Value>(map: Map<Key, Value>, limit: number) => {
  while (map.size > limit) {
    const oldest = map.keys().next();
    if (!oldest.done) map.delete(oldest.value);
  }
};

const savedTagPair = (value: JsonValue) => {
  if (Array.isArray(value) || isString(value)) return value;
  const description = value === null ? 'object null'
    : isNumber(value) ? `number ${value}`
      : value === true || value === false ? `boolean ${value}` : 'object';
  throw new TypeError(`${description} is not iterable (cannot read property Symbol(Symbol.iterator))`);
};

const nativeIdOf = (claim: PushClaim) => claim.native ? claim.nativeNid ?? claim.nid : null;

export const createPushTags = (
  store: PushTagsStore | null,
  clearApnsNotifications: ReturnType<typeof createApnsRuntime>['clearApnsNotifications'] | null,
) => {
  const open = new Map<JsonValue, PushClaim>();
  const recentlyCleared = new Map<JsonValue, JsonValue>();
  const claimedOver = new WeakMap<PushClaim, PushClaim | null>();
  const pending = new Set<string>();
  let lastNotificationId = 0;

  let persistQueued = false;
  let persistChain = Promise.resolve();
  const persist = () => {
    if (!store || persistQueued) return;
    persistQueued = true;
    persistChain = persistChain.then(async () => {
      persistQueued = false;
      try {
        await store.write({ open: [...open], cleared: [...recentlyCleared] });
      } catch (error) {
        console.warn('[Push] failed to save open notification tags:', hasErrorMessage(error) ? error.message : error);
      }
    });
  };

  const restored = store
    ? Promise.resolve()
      .then(() => store.read())
      .then((saved) => {
        if (!isJsonObject(saved)) return;
        const restoredOpen: PushTagsState['open'] = [];
        for (const value of Array.isArray(saved.open) ? saved.open : []) {
          const [tag, entry] = savedTagPair(value);
          if (!tag || !isJsonObject(entry) || !isString(entry.sessionId) || !entry.sessionId || open.has(tag)) continue;
          const claim: PushClaim = {
            sessionId: entry.sessionId,
            cause: entry.cause ?? null,
            native: entry.native === true,
            nid: entry.nid ?? null,
            skipTurnStart: entry.skipTurnStart === true,
          };
          if (isString(entry.spaceId) && entry.spaceId) claim.spaceId = entry.spaceId;
          if (isString(entry.nativeNid) && entry.nativeNid) claim.nativeNid = entry.nativeNid;
          restoredOpen.push([tag, claim]);
        }
        const merged = new Map([...restoredOpen, ...open]);
        open.clear();
        for (const [tag, entry] of merged) open.set(tag, entry);
        keepNewest(open, OPEN_PUSH_TAGS_LIMIT);

        const restoredCleared: PushTagsState['cleared'] = [];
        for (const value of Array.isArray(saved.cleared) ? saved.cleared : []) {
          const [tag, entry] = savedTagPair(value);
          if (tag && entry && !recentlyCleared.has(tag)) restoredCleared.push([tag, entry]);
        }
        const mergedCleared = new Map([...restoredCleared, ...recentlyCleared]);
        recentlyCleared.clear();
        for (const [tag, entry] of mergedCleared) recentlyCleared.set(tag, entry);
        keepNewest(recentlyCleared, RECENTLY_CLEARED_TAGS_LIMIT);
      })
      .catch((error) => {
        console.warn('[Push] failed to read open notification tags:', hasErrorMessage(error) ? error.message : error);
      })
    : Promise.resolve();

  const claimTag = async (tag: string, { sessionId, cause = null, spaceId = null }: {
    sessionId: string; cause?: JsonValue; spaceId?: string | null;
  }) => {
    await restored;
    const previous = open.get(tag) ?? null;
    const claim: PushClaim = { sessionId, cause, native: previous?.native === true, nid: previous?.nid ?? null };
    if (spaceId) claim.spaceId = spaceId;
    if (previous?.nativeNid) claim.nativeNid = previous.nativeNid;
    open.delete(tag);
    open.set(tag, claim);
    keepNewest(open, OPEN_PUSH_TAGS_LIMIT);
    claimedOver.set(claim, previous);
    return claim;
  };

  const isCurrent = (tag: string, claim: PushClaim) => open.get(tag) === claim;
  const release = (tag: string, claim: PushClaim) => {
    if (!isCurrent(tag, claim)) return;
    const previous = claimedOver.get(claim);
    open.delete(tag);
    if (previous) open.set(tag, previous);
  };

  const recordDelivery = (claim: PushClaim, native: boolean) => {
    const priorNativeId = nativeIdOf(claim);
    lastNotificationId = Math.max(Date.now(), lastNotificationId + 1);
    claim.nid = String(lastNotificationId);
    claim.native = native || Boolean(priorNativeId);
    if (!native && priorNativeId) claim.nativeNid = priorNativeId;
    else delete claim.nativeNid;
    claimedOver.delete(claim);
    persist();
  };

  const forgetDelivery = (claim: PushClaim, webId: JsonValue, nativeId: JsonValue) => {
    const currentNativeId = nativeIdOf(claim);
    if (claim.nid === webId) claim.nid = null;
    if (currentNativeId === nativeId) {
      claim.native = false;
      delete claim.nativeNid;
    } else if (currentNativeId) {
      claim.nativeNid = currentNativeId;
    }
  };

  const clear = (tags: JsonValue[], viewed?: ReadonlyMap<JsonValue, PushClaim>) => {
    const nativeEntries = [];
    for (const tag of tags) {
      const head = open.get(tag);
      const seen = viewed?.get(tag);
      const delivery = seen ?? head;
      if (!delivery) continue;
      const webId = delivery.nid;
      const nativeId = nativeIdOf(delivery);
      if (seen && head) {
        if (nativeId === nativeIdOf(head) && isString(tag)) pending.delete(tag);
        let current: PushClaim | null | undefined = head;
        while (current) {
          forgetDelivery(current, webId, nativeId);
          const previous: PushClaim | null | undefined = claimedOver.get(current);
          if (previous && !claimedOver.has(previous) && !previous.nid && !nativeIdOf(previous)) {
            claimedOver.set(current, null);
          }
          current = previous;
        }
        if (!claimedOver.has(head) && !head.nid && !nativeIdOf(head)) open.delete(tag);
      } else {
        open.delete(tag);
        if (isString(tag)) pending.delete(tag);
      }
      const cutoff = webId || nativeId;
      const prior = recentlyCleared.get(tag);
      if (cutoff && (!isString(prior) || Number(prior.slice(prior.lastIndexOf('@') + 1)) < Number(cutoff))) {
        recentlyCleared.delete(tag);
        recentlyCleared.set(tag, `${tag}@${cutoff}`);
      }
      if (nativeId) nativeEntries.push(`${tag}@${nativeId}`);
    }
    if (!tags.length) return;
    keepNewest(recentlyCleared, RECENTLY_CLEARED_TAGS_LIMIT);
    persist();
    if (nativeEntries.length === 0 || !clearApnsNotifications) return;
    Promise.resolve(clearApnsNotifications({ tags: nativeEntries, badge: pending.size })).catch((error) => {
      console.warn('[APNs] clearing failed:', hasErrorMessage(error) ? error.message : error);
    });
  };

  const clearTag = async (tag: string, cause: JsonValue = null) => {
    await restored;
    const head = open.get(tag);
    if (!head || (cause !== null && head.cause !== null && head.cause !== cause)) return;
    clear([tag]);
  };

  return {
    open, restored, persist, claimTag, isCurrent, release, clear, clearTag, recordDelivery,
    clearPendingBadge: () => pending.clear(),
    countBadge: (tag: string) => {
      if (tag.length > 0) pending.add(tag);
      return pending.size;
    },
    clearEntriesForPush: (tag: string, native: boolean) => {
      if (native) recentlyCleared.delete(tag);
      return [...recentlyCleared].filter(([key]) => key !== tag).map(([, entry]) => entry);
    },
  };
};
