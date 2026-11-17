import type { Session } from '@/lib/opencode/model';
import { isOperatorChildSession } from '@/lib/sessionOperatorChild';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { hasActiveSubagent, useGlobalSessionStatusStore } from './global-session-status';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { abortCurrentOperation } from './session-actions';

type OperatorChildrenDoneChoice = 'stop' | 'finish' | 'cancel';

type PendingQuestion = {
  titles: readonly string[];
  resolve: (choice: OperatorChildrenDoneChoice) => void;
};

let pending: PendingQuestion | null = null;
const listeners = new Set<() => void>();

const emitChange = (): void => {
  for (const listener of listeners) listener();
};

export const getOperatorChildrenDoneQuestion = (): PendingQuestion | null => pending;

export const subscribeOperatorChildrenDoneQuestion = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export const answerOperatorChildrenDoneQuestion = (choice: OperatorChildrenDoneChoice): void => {
  const question = pending;
  pending = null;
  emitChange();
  question?.resolve(choice);
};

const ask = (titles: readonly string[]): Promise<OperatorChildrenDoneChoice> => {
  pending?.resolve('cancel');
  return new Promise((resolve) => {
    pending = { titles, resolve };
    emitChange();
  });
};

const childrenByParent = (sessions: readonly Session[]): Map<string, Session[]> => {
  const children = new Map<string, Session[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const siblings = children.get(session.parentID);
    if (siblings) siblings.push(session);
    else children.set(session.parentID, [session]);
  }
  return children;
};

const collectSubtree = (rootId: string, children: Map<string, Session[]>): Session[] => {
  const found: Session[] = [];
  const stack = [...(children.get(rootId) ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const session = stack.pop();
    if (!session || seen.has(session.id)) continue;
    seen.add(session.id);
    found.push(session);
    stack.push(...(children.get(session.id) ?? []));
  }
  return found;
};

export const findRunningOperatorChildren = (
  rootIds: readonly string[],
  sessions: readonly Session[],
  activeSessionIds: ReadonlySet<string>,
): Session[] => {
  const children = childrenByParent(sessions);
  const parentOf = (id: string) => sessions.find((session) => session.id === id)?.parentID;
  const running = new Map<string, Session>();
  for (const rootId of rootIds) {
    for (const session of collectSubtree(rootId, children)) {
      if (!isOperatorChildSession(session)) continue;
      if (activeSessionIds.has(session.id) || hasActiveSubagent(session.id, activeSessionIds, parentOf)) running.set(session.id, session);
    }
  }
  return [...running.values()];
};

export const settleRunningOperatorChildren = (rootIds: readonly string[]): true | Promise<boolean> => {
  const running = readRunning(rootIds);
  return running.length === 0 ? true : askAndSettle(rootIds, running);
};

const readRunning = (rootIds: readonly string[]): Session[] => findRunningOperatorChildren(
  rootIds,
  useGlobalSessionsStore.getState().activeSessions,
  useGlobalSessionStatusStore.getState().activeSessionIds,
);

const askAndSettle = async (rootIds: readonly string[], running: readonly Session[]): Promise<boolean> => {
  const runtimeKey = getRuntimeKey();
  const choice = await ask(running.map((session) => session.title));
  if (choice === 'cancel' || getRuntimeKey() !== runtimeKey) return false;
  if (choice === 'stop') {
    const sessions = useGlobalSessionsStore.getState().activeSessions;
    const { activeSessionIds } = useGlobalSessionStatusStore.getState();
    const children = childrenByParent(sessions);
    const stopping = readRunning(rootIds).flatMap((session) => [session, ...collectSubtree(session.id, children)])
      .filter((session) => activeSessionIds.has(session.id));
    await Promise.all(stopping.map((session) => abortCurrentOperation(session.id)));
  }
  return getRuntimeKey() === runtimeKey;
};
