import { describe, expect, test } from 'bun:test';
import type { TerminalAPI, TerminalHandlers } from './api/types';
import { waitForTerminalExit } from './projectActionTerminal';
import { detectDevServerCommand } from './detectDevServer';

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
  test('preserves a configured dev action preview URL', async () => {
    const detected = await detectDevServerCommand('/repo', [{
      id: 'dev',
      name: 'Dev server',
      command: 'bun run dev',
      openUrl: 'http://localhost:4321',
    }], null);
    expect(detected?.previewUrlHint).toBe('http://localhost:4321');
  });

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
});
