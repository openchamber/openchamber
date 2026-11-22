import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PersistentPtyInfo } from '@opencode/client';
import { opencodeClient } from '@/lib/opencode/client';
import { agentTerminalState, resetPersistentPtys, usePersistentPtysStore } from '@/sync/persistent-ptys';
import { useSessionTerminalsLoaded } from './usePersistentTerminals';

const terminal = (status: PersistentPtyInfo['status'], exitCode?: number): PersistentPtyInfo => {
  const info: PersistentPtyInfo = {
    id: 'pty_1', title: 'dev', command: 'bun', args: ['run', 'dev'], cwd: '/repo', status, pid: 1, sessionID: 'ses_a',
    foregroundProcess: null, size: { cols: 120, rows: 40 }, output: { head: 0, tail: 0 },
  };
  if (exitCode !== undefined) info.exitCode = exitCode;
  return info;
};

const Probe = () => {
  useSessionTerminalsLoaded('ses_a', '/repo');
  return null;
};

let windowInstance: Window;
let root: Root;

beforeEach(() => {
  windowInstance = new Window();
  Object.assign(globalThis, {
    window: windowInstance,
    document: windowInstance.document,
    HTMLElement: windowInstance.HTMLElement,
    Element: windowInstance.Element,
    Node: windowInstance.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  jest.useFakeTimers();
  resetPersistentPtys();
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  jest.useRealTimers();
  await windowInstance.happyDOM.close();
  resetPersistentPtys();
});

const advance = (ms: number) => act(async () => {
  jest.advanceTimersByTime(ms);
});

test('a running terminal is read again every 5 s until its exit shows, then no more', async () => {
  let exited = false;
  let reads = 0;
  const list = spyOn(opencodeClient, 'listSessionTerminals').mockImplementation(async () => {
    reads += 1;
    return [exited ? terminal('exited', 3) : terminal('running')];
  });
  try {
    await act(async () => root.render(<Probe />));
    const state = () => {
      const pty = usePersistentPtysStore.getState().byId.get('pty_1');
      return pty ? agentTerminalState(pty) : undefined;
    };
    expect(state()).toEqual({ kind: 'running' });

    const shown = reads;
    await advance(5_000);
    expect(reads).toBe(shown + 1);

    // OpenCode announces no exit: the next read is where it shows.
    exited = true;
    await advance(5_000);
    expect(state()).toEqual({ kind: 'exited', exitCode: 3 });

    const afterExit = reads;
    await advance(30_000);
    expect(reads).toBe(afterExit);
    expect(list.mock.calls.every(([sessionID, directory]) => sessionID === 'ses_a' && directory === '/repo')).toBe(true);
  } finally {
    list.mockRestore();
  }
});

test('a session without a running terminal is read once when shown', async () => {
  let reads = 0;
  const list = spyOn(opencodeClient, 'listSessionTerminals').mockImplementation(async () => {
    reads += 1;
    return [terminal('exited', 0)];
  });
  try {
    await act(async () => root.render(<Probe />));
    expect(reads).toBe(1);
    await advance(30_000);
    expect(reads).toBe(1);
  } finally {
    list.mockRestore();
  }
});
