import { describe, expect, test } from 'bun:test';
import type { TerminalAPI, TerminalHandlers, TerminalServerSession } from './api/types';
import { normalizeTerminalDirectory } from './pathNormalization';
import {
  createProjectActionTerminalSession,
  groupTerminalSessionsByDirectory,
  normalizeProjectActionCommand,
  reconcileTerminalSessionAuthority,
  stopProjectActionTerminalSession,
  waitForTerminalExit,
} from './projectActionTerminal';

const fakeTerminal = () => {
  let handlers: TerminalHandlers | null = null;
  let closed = false;
  const terminal: TerminalAPI = {
    createSession: async () => ({ sessionId: 'term-1', cols: 80, rows: 24, status: 'running' }),
    connect: (_id, nextHandlers) => { handlers = nextHandlers; return { close: () => { closed = true; } }; },
    sendInput: async () => {}, resize: async () => {}, close: async () => {},
  };
  return { terminal, emit: (event: Parameters<TerminalHandlers['onEvent']>[0]) => handlers?.onEvent(event), isClosed: () => closed };
};

describe('project action terminal lifecycle', () => {
  test('resolves on live exit and closes its temporary subscription', async () => {
    const fake = fakeTerminal();
    const result = waitForTerminalExit(fake.terminal, 'term-1', 100);
    fake.emit({ type: 'exit', sequence: 2, exitCode: 0 });
    expect(await result).toBe(true);
    expect(fake.isClosed()).toBe(true);
  });

  test('recognizes an already-exited reconnect snapshot', async () => {
    const fake = fakeTerminal();
    const result = waitForTerminalExit(fake.terminal, 'term-1', 100);
    fake.emit({ type: 'snapshot', sequence: 2, status: 'exited', data: 'done' });
    expect(await result).toBe(true);
  });

  test('returns false on timeout so the caller can force-kill', async () => {
    const fake = fakeTerminal();
    expect(await waitForTerminalExit(fake.terminal, 'term-1', 5)).toBe(false);
    expect(fake.isClosed()).toBe(true);
  });

  test('normalizes a project action command before create', () => {
    expect(normalizeProjectActionCommand('  printf "hi"\r\nexit\u0007  ')).toBe('printf "hi"\nexit');
  });

  test('creates a command-mode run under its execution ID', async () => {
    const calls: string[] = [];
    const terminal: TerminalAPI = {
      createSession: async (options) => {
        calls.push(`create:${JSON.stringify(options)}`);
        return { sessionId: 'exec-1', cols: 80, rows: 24, status: 'running', mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' } };
      },
      connect: () => ({ close: () => {} }),
      sendInput: async () => {},
      resize: async () => {},
      close: async (sessionId) => {
        calls.push(`close:${sessionId}`);
      },
    };

    const created = await createProjectActionTerminalSession({
      terminal,
      createOptions: {
        cwd: '/repo',
      },
      command: 'echo hello',
      isRunStillExpected: () => true,
      purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' },
    });

    expect(created).toEqual({ sessionId: 'exec-1', cols: 80, rows: 24, status: 'running', mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' } });
    expect(calls).toEqual([
      'create:{"cwd":"/repo","sessionId":"exec-1","mode":"command","command":"echo hello","purpose":{"type":"project-action","actionId":"build","executionId":"exec-1"}}',
    ]);
  });

  test('rejects and closes a create response that does not echo command mode', async () => {
    const closed: string[] = [];
    const terminal: TerminalAPI = {
      createSession: async () => ({ sessionId: 'exec-1', cols: 80, rows: 24, status: 'running' }),
      connect: () => ({ close: () => {} }),
      sendInput: async () => {},
      resize: async () => {},
      close: async (sessionId) => {
        closed.push(sessionId);
      },
    };

    await expect(createProjectActionTerminalSession({
      terminal,
      createOptions: {
        cwd: '/repo',
      },
      command: 'echo hello',
      isRunStillExpected: () => true,
      purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' },
    })).rejects.toThrow('COMMAND_MODE_UNSUPPORTED');
    expect(closed).toEqual(['exec-1']);
  });

  test('closes a newly created command session when stop removes the run during create', async () => {
    const closed: string[] = [];
    const terminal: TerminalAPI = {
      createSession: async () => ({ sessionId: 'exec-1', cols: 80, rows: 24, status: 'running', mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' } }),
      connect: () => ({ close: () => {} }),
      sendInput: async () => {},
      resize: async () => {},
      close: async (sessionId) => {
        closed.push(sessionId);
      },
    };

    await expect(createProjectActionTerminalSession({
      terminal,
      createOptions: {
        cwd: '/repo',
      },
      command: 'echo hello',
      isRunStillExpected: () => false,
      purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' },
    })).rejects.toThrow('PROJECT_ACTION_RUN_CANCELLED');
    expect(closed).toEqual(['exec-1']);
  });

  test('rejects and closes a create response that does not echo project-action purpose', async () => {
    const closed: string[] = [];
    const terminal: TerminalAPI = {
      createSession: async () => ({ sessionId: 'exec-1', cols: 80, rows: 24, status: 'running', mode: 'command' }),
      connect: () => ({ close: () => {} }),
      sendInput: async () => {},
      resize: async () => {},
      close: async (sessionId) => {
        closed.push(sessionId);
      },
    };

    await expect(createProjectActionTerminalSession({
      terminal,
      createOptions: { cwd: '/repo' },
      command: 'echo hello',
      isRunStillExpected: () => true,
      purpose: { type: 'project-action', actionId: 'build', executionId: 'exec-1' },
    })).rejects.toThrow('PROJECT_ACTION_PURPOSE_UNSUPPORTED');
    expect(closed).toEqual(['exec-1']);
  });

  test('reuses one in-flight authority listing per directory', async () => {
    let calls = 0;
    let resolveSessions: ((value: Array<{ sessionId: string; cwd: string; status: 'running'; createdAt: number | null }>) => void) | undefined;
    const capturedRevisions: number[] = [];
    const terminal: TerminalAPI = {
      listSessions: async () => {
        calls += 1;
        return await new Promise((resolve) => {
          resolveSessions = resolve;
        });
      },
      createSession: async () => ({ sessionId: 'ignored', cols: 80, rows: 24, status: 'running' }),
      connect: () => ({ close: () => {} }),
      sendInput: async () => {},
      resize: async () => {},
      close: async () => {},
    };
    const captureStartedActionMutationRevisions = () => {
      const revision = capturedRevisions.length + 1;
      capturedRevisions.push(revision);
      return new Map([['/repo::build', revision]]);
    };

    const first = reconcileTerminalSessionAuthority(terminal, '/repo', {
      captureStartedActionMutationRevisions,
    });
    const second = reconcileTerminalSessionAuthority(terminal, '/repo', {
      captureStartedActionMutationRevisions,
    });
    expect(first).toBe(second);
    const finishListing = resolveSessions;
    if (!finishListing) {
      throw new Error('list resolver was not captured');
    }
    finishListing([{ sessionId: 'srv-1', cwd: '/repo', status: 'running', createdAt: 1 }]);
    expect(await first).toEqual({
      sessions: [{ sessionId: 'srv-1', cwd: '/repo', status: 'running', createdAt: 1 }],
      startedActionMutationRevisions: new Map([['/repo::build', 1]]),
    });
    expect(calls).toBe(1);
    expect(capturedRevisions).toEqual([1]);
  });

  test('does not share an authority listing across runtime adapters', async () => {
    const calls: string[] = [];
    const createTerminal = (name: string): TerminalAPI => ({
      listSessions: async () => {
        calls.push(name);
        return [];
      },
      createSession: async () => ({ sessionId: 'ignored', cols: 80, rows: 24, status: 'running' }),
      connect: () => ({ close: () => {} }),
      sendInput: async () => {},
      resize: async () => {},
      close: async () => {},
    });

    await Promise.all([
      reconcileTerminalSessionAuthority(createTerminal('runtime-a'), '/repo'),
      reconcileTerminalSessionAuthority(createTerminal('runtime-b'), '/repo'),
    ]);

    expect(calls).toEqual(['runtime-a', 'runtime-b']);
  });

  test('stale stop completion does not interrupt or force-kill a newer execution and cleanup runs once', async () => {
    const sent: string[] = [];
    const forceKillCalls: string[] = [];
    const subscriptions: Array<{ handlers: TerminalHandlers; closed: number }> = [];
    let current = true;
    const terminal: TerminalAPI = {
      createSession: async () => ({ sessionId: 'unused', cols: 80, rows: 24, status: 'running' }),
      connect: (_id, handlers) => {
        const record = { handlers, closed: 0 };
        subscriptions.push(record);
        return { close: () => { record.closed += 1; } };
      },
      sendInput: async (sessionId, input) => {
        sent.push(`${sessionId}:${input}`);
        current = false;
      },
      resize: async () => {},
      close: async () => {},
      forceKill: async ({ sessionId }) => {
        forceKillCalls.push(sessionId ?? '');
      },
    };
    let stopping = 0;
    let restored = 0;
    let cleared = 0;
    let finalized = 0;

    await stopProjectActionTerminalSession({
      terminal,
      sessionId: 'srv-1',
      isExecutionStillCurrent: () => current,
      markStopping: () => { stopping += 1; },
      restoreRunning: () => { restored += 1; },
      clearSession: () => { cleared += 1; },
      finalizeExit: () => { finalized += 1; },
      timeoutMs: 1,
    });

    expect(sent).toEqual(['srv-1:\x03']);
    expect(forceKillCalls).toEqual([]);
    expect(stopping).toBe(1);
    expect(restored).toBe(0);
    expect(cleared).toBe(0);
    expect(finalized).toBe(0);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]?.closed).toBe(1);
  });

  test('stop failure returns the action to a retryable running state', async () => {
    const terminal: TerminalAPI = {
      createSession: async () => ({ sessionId: 'unused', cols: 80, rows: 24, status: 'running' }),
      connect: (_id, handlers) => ({ close: () => { handlers.onError?.(new Error('ignored'), false); } }),
      sendInput: async () => {},
      resize: async () => {},
      close: async () => { throw new Error('close failed'); },
    };
    let restored = 0;
    let finalized = 0;

    await stopProjectActionTerminalSession({
      terminal,
      sessionId: 'srv-1',
      isExecutionStillCurrent: () => true,
      markStopping: () => undefined,
      restoreRunning: () => { restored += 1; },
      clearSession: () => undefined,
      finalizeExit: () => { finalized += 1; },
      timeoutMs: 1,
    });

    expect(restored).toBe(1);
    expect(finalized).toBe(0);
  });
});

test('cancelling a local request does not close a run adopted from another client', async () => {
  const closed: string[] = [];
  const terminal: TerminalAPI = {
    createSession: async () => ({ sessionId: 'other-client', cols: 80, rows: 24, status: 'running', mode: 'command', purpose: { type: 'project-action', actionId: 'build', executionId: 'other-execution' } }),
    connect: () => ({ close() {} }),
    sendInput: async () => {}, resize: async () => {},
    close: async id => { closed.push(id); },
  };
  await expect(createProjectActionTerminalSession({
    terminal, createOptions: { cwd: '/repo' }, command: 'echo hello',
    purpose: { type: 'project-action', actionId: 'build', executionId: 'requested-execution' },
    isRunStillExpected: () => false,
  })).rejects.toThrow('PROJECT_ACTION_RUN_CANCELLED');
  expect(closed).toEqual([]);
});

test('a whole-server listing groups under the same directory keys the terminal store uses', () => {
  // The sidebar reconciles by these keys while the terminal panel reconciles by
  // the store's own key for the same folder; a Windows path must not split into
  // two namespaces (`c:\\repo` from the server, `C:/repo` from the sidebar).
  const session = (sessionId: string, cwd: string): TerminalServerSession => ({
    sessionId, cwd, status: 'running', createdAt: 1, mode: 'command',
    purpose: { type: 'project-action', actionId: 'dev', executionId: sessionId },
  });
  const grouped = groupTerminalSessionsByDirectory([
    session('a', 'c:\\repo'),
    session('b', 'C:/repo/'),
    session('c', '/srv/app/'),
  ]);

  expect([...grouped.keys()].sort()).toEqual(['/srv/app', 'C:/repo']);
  expect(grouped.get('C:/repo')?.map(entry => entry.sessionId)).toEqual(['a', 'b']);
  expect(normalizeTerminalDirectory('c:\\repo')).toBe('C:/repo');
});
