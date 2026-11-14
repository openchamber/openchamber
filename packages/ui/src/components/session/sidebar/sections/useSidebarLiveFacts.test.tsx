import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { SyncEvent } from '@/lib/opencode/events';
import type { Session } from '@/lib/opencode/model';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { applyBackgroundShellEvents, resetBackgroundShells } from '@/sync/background-shells';
import { replaceGlobalSessionStatusById, setSessionParentResolver } from '@/sync/global-session-status';
import { applyPrWatches, resetPrWatchesForRuntimeSwitch } from '@/sync/pr-watch';
import { setWorkflowRunningSessions } from '@/sync/workflow-activity';
import { installHookTestDom } from '../test-utils/testDom';
import { useSidebarLiveFacts } from './useSidebarLiveFacts';
import type { SidebarLiveFacts } from './workFacts';

// `time.idle` is stamped however much work the turn left running.
const finished = (id: string, parentID?: string): Session => ({
  id, parentID, projectID: 'p', directory: '/repo', title: id, cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2, idle: 2 },
});

const shellStarted: SyncEvent = {
  type: 'shell.started',
  properties: { shell: { id: 'sh_1', sessionID: 'waiting', command: 'sleep 300', file: '/tmp/sh_1.out', startedAt: 1 } },
};
const shellEnded: SyncEvent = { type: 'shell.ended', properties: { shellID: 'sh_1', end: { kind: 'exited', status: 'exited', exit: 0 }, endedAt: 2 } };

const reset = () => {
  useGlobalSessionsStore.getState().resetForRuntimeSwitch();
  replaceGlobalSessionStatusById(new Map());
  resetBackgroundShells();
  resetPrWatchesForRuntimeSwitch();
  setWorkflowRunningSessions([]);
  setSessionParentResolver(() => undefined);
};

let dom: ReturnType<typeof installHookTestDom>;
let root: ReturnType<typeof createRoot>;
let facts: SidebarLiveFacts;

const Harness = ({ enabled = true }: { enabled?: boolean }) => {
  facts = useSidebarLiveFacts(enabled);
  return null;
};

const expectWaiting = () => {
  expect(facts.unreadIds.has('waiting')).toBe(false);
  expect(facts.activeIds.has('waiting')).toBe(true);
  // A finished session beside it stays unread.
  expect(facts.unreadIds.has('finished')).toBe(true);
};

beforeEach(async () => {
  reset();
  dom = installHookTestDom();
  root = createRoot(dom.container);
  useGlobalSessionsStore.getState().upsertSessions([finished('waiting'), finished('finished')]);
  await act(async () => root.render(<Harness />));
  expect([...facts.unreadIds].sort()).toEqual(['finished', 'waiting']);
  expect(facts.activeIds.size).toBe(0);
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.restore();
  reset();
});

test('a session idling on a background command is running until it ends, then unread', async () => {
  await act(async () => applyBackgroundShellEvents('/repo', [shellStarted]));
  expectWaiting();

  await act(async () => applyBackgroundShellEvents('/repo', [shellEnded]));
  expect(facts.unreadIds.has('waiting')).toBe(true);
  expect(facts.activeIds.has('waiting')).toBe(false);
});

test('a session idling on a background subagent is running until it ends, then unread', async () => {
  await act(async () => {
    useGlobalSessionsStore.getState().upsertSessions([finished('child', 'waiting')]);
    setSessionParentResolver((id) => (id === 'child' ? 'waiting' : undefined));
    replaceGlobalSessionStatusById(new Map([['child', { directory: '/repo', status: { type: 'busy' } }]]));
  });
  expectWaiting();

  await act(async () => replaceGlobalSessionStatusById(new Map()));
  expect(facts.unreadIds.has('waiting')).toBe(true);
});

test('a session idling on a workflow run or its pull request is running', async () => {
  await act(async () => setWorkflowRunningSessions(['waiting']));
  expectWaiting();
  await act(async () => setWorkflowRunningSessions([]));
  expect(facts.unreadIds.has('waiting')).toBe(true);

  await act(async () => applyPrWatches(1, 'waiting', [{
    sessionID: 'waiting', directory: '/repo', url: 'https://example.test/pr/1', number: 1, title: 'PR', status: 'pending', startedAt: 1,
  }]));
  expectWaiting();
});

test('nothing is read while no shown section asks', async () => {
  await act(async () => applyBackgroundShellEvents('/repo', [shellStarted]));
  await act(async () => root.render(<Harness enabled={false} />));
  expect(facts.activeIds.size).toBe(0);
  expect(facts.unreadIds.size).toBe(0);
});
