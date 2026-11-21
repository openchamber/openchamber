import { afterEach, describe, expect, test } from 'bun:test';

import type { CreateTerminalOptions, TerminalAPI, TerminalSession } from '@/lib/api/types';
import { useTerminalStore } from '@/stores/useTerminalStore';

import { replyCommandShell, ReplyTerminalUnsupportedError, startReplyTerminal } from './replyTerminal';

const fakeTerminal = (respond: (options: CreateTerminalOptions) => TerminalSession) => {
  const created: CreateTerminalOptions[] = [];
  const closed: Array<[string, string | null | undefined]> = [];
  const terminal: TerminalAPI = {
    createSession: async (options) => {
      created.push(options);
      return respond(options);
    },
    connect: () => ({ close: () => {} }),
    sendInput: async () => {}, resize: async () => {},
    close: async (sessionId, directory) => {
      closed.push([sessionId, directory]);
    },
  };
  return { terminal, created, closed };
};

const start = (terminal: TerminalAPI, command = 'echo hi') => startReplyTerminal({
  terminal,
  directory: '/repo',
  command,
  shell: 'zsh',
  loginShells: ['zsh'],
  createOptions: { cols: 80, rows: 24 },
  isCurrent: () => true,
});

afterEach(() => useTerminalStore.getState().clearAll());

describe('replyCommandShell', () => {
  test('a shell-tagged fence runs in that shell, a generic one in the terminal shell', () => {
    expect(replyCommandShell('bash', 'pwsh')).toBe('bash');
    expect(replyCommandShell('ZSH', 'pwsh')).toBe('zsh');
    expect(replyCommandShell('sh', 'pwsh')).toBe('sh');
    expect(replyCommandShell('shell', 'pwsh')).toBe('pwsh');
  });
});

describe('startReplyTerminal', () => {
  test('an adoption that arrives before the create response leaves one active command tab', async () => {
    const { terminal, created } = fakeTerminal((options) => {
      useTerminalStore.getState().reconcileServerSessions('/repo', [{
        sessionId: options.sessionId!, cwd: '/repo', status: 'running', createdAt: 1, mode: 'command',
      }]);
      return { sessionId: options.sessionId!, cols: 80, rows: 24, status: 'running', mode: 'command' };
    });

    const tabId = await start(terminal, '  printf "a"\u0007\r\n');

    expect(created[0]).toMatchObject({ mode: 'command', command: 'printf "a"', shell: 'zsh', loginShell: true, purpose: { type: 'terminal' } });
    const state = useTerminalStore.getState().getDirectoryState('/repo')!;
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0]).toMatchObject({ id: tabId, terminalSessionId: created[0]!.sessionId, mode: 'command', lifecycle: 'running' });
    expect(state.activeTabId).toBe(tabId);
  });

  test('a server that opens an interactive shell instead gets it closed and publishes no tab', async () => {
    for (const mode of ['interactive', undefined] as const) {
      const { terminal, closed } = fakeTerminal((options) => ({ sessionId: options.sessionId!, cols: 80, rows: 24, status: 'running', mode }));

      await expect(start(terminal)).rejects.toBeInstanceOf(ReplyTerminalUnsupportedError);

      expect(closed).toHaveLength(1);
      expect(closed[0]![1]).toBe('/repo');
      expect(useTerminalStore.getState().getDirectoryState('/repo')).toBeUndefined();
    }
  });

  test('a rejected session the listing adopted before the response leaves no tab bound to it', async () => {
    for (const mode of ['interactive', undefined] as const) {
      const { terminal, created } = fakeTerminal((options) => {
        useTerminalStore.getState().reconcileServerSessions('/repo', [{
          sessionId: options.sessionId!, cwd: '/repo', status: 'running', createdAt: 1, mode,
        }]);
        return { sessionId: options.sessionId!, cols: 80, rows: 24, status: 'running', mode };
      });

      await expect(start(terminal)).rejects.toBeInstanceOf(ReplyTerminalUnsupportedError);

      const tabs = useTerminalStore.getState().getDirectoryState('/repo')?.tabs ?? [];
      expect(tabs.some((tab) => tab.id === created[0]!.sessionId || tab.terminalSessionId !== null)).toBe(false);
      useTerminalStore.getState().clearAll();
    }
  });
});
