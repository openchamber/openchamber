import type { ChatMessageEntry, TurnProjectionResult } from './types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

const TURN_PROJECTION_CACHE_MAX = 30;
const VSCODE_TURN_PROJECTION_CACHE_MAX = 4;
const MOBILE_TURN_PROJECTION_CACHE_MAX = 4;

// A projection contains message/part references. Cache hits may reuse a live
// projection, but this cache must not keep an evicted transcript alive.
const projectionCache = new Map<string, WeakRef<TurnProjectionResult>>();
const objectVersionByRef = new WeakMap<object, number>();
let nextObjectVersion = 1;

const getProjectionCacheMax = () => {
  if (isVSCodeRuntime()) return VSCODE_TURN_PROJECTION_CACHE_MAX;
  if (isMobileSurfaceRuntime()) return MOBILE_TURN_PROJECTION_CACHE_MAX;
  return TURN_PROJECTION_CACHE_MAX;
};

const getObjectVersion = (value: object): number => {
  const cached = objectVersionByRef.get(value);
  if (cached !== undefined) return cached;
  const next = nextObjectVersion;
  nextObjectVersion += 1;
  objectVersionByRef.set(value, next);
  return next;
};

// One version pair per message: its info record and its parts array. Store
// reducers never mutate either in place: a part update replaces the message's
// parts array, and a message update replaces its info. So the pair changes
// whenever anything the projection reads changes, and individual parts need
// no signature of their own.
const buildMessagesVersionSignature = (messages: ChatMessageEntry[]): string => {
  let signature = '';
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (index > 0) signature += ';';
    signature += `${getObjectVersion(message.info)}:${getObjectVersion(message.parts)}`;
  }
  return signature;
};

export const buildProjectionCacheKey = (
  sessionKey: string,
  messages: ChatMessageEntry[],
  showTextJustificationActivity: boolean,
  showTurnChangedFiles: boolean,
  mergeHiddenUserTurnsKey: string,
): string => {
  return [
    sessionKey,
    buildMessagesVersionSignature(messages),
    showTextJustificationActivity ? '1' : '0',
    showTurnChangedFiles ? '1' : '0',
    mergeHiddenUserTurnsKey,
  ].join('|');
};

export const getCachedProjection = (key: string): TurnProjectionResult | undefined => {
  const reference = projectionCache.get(key);
  const cached = reference?.deref();
  if (reference && cached) {
    // LRU re-order: move hit to the end (most recent) so it survives
    // eviction longer than entries that haven't been read recently.
    projectionCache.delete(key);
    projectionCache.set(key, reference);
  } else {
    projectionCache.delete(key);
  }
  return cached;
};

export const setCachedProjection = (
  key: string,
  projection: TurnProjectionResult,
): void => {
  projectionCache.delete(key);
  const max = getProjectionCacheMax();
  while (projectionCache.size >= max) {
    const oldest = projectionCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    projectionCache.delete(oldest);
  }
  projectionCache.set(key, new WeakRef(projection));
};
