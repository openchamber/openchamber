import type { Session, SessionStatus } from '@opencode-ai/sdk/v2';

import type { DisposableSideChatIdentity } from '@/lib/sideChats/types';
import type { SideChatRuntimeOperation } from '@/lib/sideChats/runtimeOperation';

export type { DisposableSideChatIdentity } from '@/lib/sideChats/types';

type DisposableSideChatActivity = {
  status: SessionStatus | null | undefined;
  permissionCount: number;
  questionCount: number;
};

export const hasActiveDisposableSideChatWork = (activity: DisposableSideChatActivity): boolean => (
  activity.status?.type === 'busy'
  || activity.status?.type === 'retry'
  || activity.permissionCount > 0
  || activity.questionCount > 0
);

export const waitForDisposableSideChatToSettle = async (
  isBusy: () => boolean,
  timeoutMs = 5_000,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isBusy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isBusy();
};

export const requestDisposableSideChatPromotion = async (
  identity: DisposableSideChatIdentity,
  operation: SideChatRuntimeOperation,
): Promise<Session> => {
  const response = await operation.fetch(`/api/openchamber/side-chats/${encodeURIComponent(identity.sideSessionId)}/promote`, {
    method: 'POST',
    query: { directory: identity.directory },
  });
  const payload = await response.json().catch(() => null) as (Session & { error?: string }) | null;
  const hasSideChatMarker = Boolean((payload as Session & {
    metadata?: { openchamber?: { sideChat?: unknown } };
  } | null)?.metadata?.openchamber?.sideChat);
  if (!response.ok || payload?.id !== identity.sideSessionId || hasSideChatMarker) {
    throw new Error(payload?.error || `Side chat promotion failed (${response.status})`);
  }
  return payload;
};

type CloseDependencies = {
  isActive: () => boolean;
  abort: () => Promise<void>;
  waitUntilSettled: () => Promise<boolean>;
  deleteSession: () => Promise<boolean>;
  complete: (identity: DisposableSideChatIdentity) => void;
  closeTab: () => void;
};

type PromoteDependencies = {
  promote: () => Promise<Session>;
  publish: (session: Session) => void;
  complete: (identity: DisposableSideChatIdentity) => void;
  closeTab: () => void;
  navigate: (session: Session) => Promise<void> | void;
};

type DisposableSideChatLifecycleResult = { ok: true } | { ok: false; error: Error };

const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
const operations = new Map<string, Promise<DisposableSideChatLifecycleResult>>();
const operationTails = new Map<string, Promise<void>>();
const operationKey = (identity: DisposableSideChatIdentity): string => JSON.stringify([
  identity.runtimeKey, identity.directory, identity.sideSessionId,
]);
const serializeLifecycle = (
  identity: DisposableSideChatIdentity,
  operation: () => Promise<DisposableSideChatLifecycleResult>,
): Promise<DisposableSideChatLifecycleResult> => {
  const key = operationKey(identity);
  const existing = operations.get(key);
  if (existing) return existing;
  const previous = operationTails.get(key) ?? Promise.resolve();
  const running = previous.catch(() => undefined).then(operation);
  const tracked = running.finally(() => {
    if (operations.get(key) === tracked) operations.delete(key);
  });
  operations.set(key, tracked);
  const tail = tracked.then(() => undefined, () => undefined);
  operationTails.set(key, tail);
  void tail.finally(() => {
    if (operationTails.get(key) === tail) operationTails.delete(key);
  });
  return tracked;
};

export const serializeDisposableSideChatSend = async <T>(
  identity: DisposableSideChatIdentity,
  operation: () => Promise<T>,
): Promise<T> => {
  const key = operationKey(identity);
  const previous = operationTails.get(key) ?? Promise.resolve();
  const running = previous.catch(() => undefined).then(operation);
  const tail = running.then(() => undefined, () => undefined);
  operationTails.set(key, tail);
  void tail.finally(() => {
    if (operationTails.get(key) === tail) operationTails.delete(key);
  });
  return running;
};

export const closeDisposableSideChat = async (
  identity: DisposableSideChatIdentity,
  dependencies: CloseDependencies,
): Promise<DisposableSideChatLifecycleResult> => {
  return serializeLifecycle(identity, async () => { try {
    if (dependencies.isActive()) {
      await dependencies.abort();
      if (!await dependencies.waitUntilSettled()) {
        throw new Error('Side chat did not stop before cleanup');
      }
    }
    if (!await dependencies.deleteSession()) {
      throw new Error('Side chat deletion was not confirmed');
    }
    dependencies.complete(identity);
    dependencies.closeTab();
    return { ok: true };
  } catch (error) {
    return { ok: false, error: asError(error) };
  } });
};

export const promoteDisposableSideChat = async (
  identity: DisposableSideChatIdentity,
  dependencies: PromoteDependencies,
): Promise<DisposableSideChatLifecycleResult> => {
  return serializeLifecycle(identity, async () => { try {
    const session = await dependencies.promote();
    dependencies.publish(session);
    dependencies.complete(identity);
    dependencies.closeTab();
    await dependencies.navigate(session);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: asError(error) };
  } });
};
