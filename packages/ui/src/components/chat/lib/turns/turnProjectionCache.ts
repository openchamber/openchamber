import type { ChatMessageEntry, TurnProjectionResult } from './types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';

const TURN_PROJECTION_CACHE_MAX = 30;
const VSCODE_TURN_PROJECTION_CACHE_MAX = 4;
const MOBILE_TURN_PROJECTION_CACHE_MAX = 4;

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
  showTurnChangedFiles: boolean,
  mergeHiddenUserTurnsKey: string,
): string => {
  return [
    sessionKey,
    buildMessagesVersionSignature(messages),
    showTurnChangedFiles ? '1' : '0',
    mergeHiddenUserTurnsKey,
  ].join('|');
};

export const getCachedProjection = (key: string): TurnProjectionResult | undefined => {
  const reference = projectionCache.get(key);
  const cached = reference?.deref();
  if (reference && cached) {
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
