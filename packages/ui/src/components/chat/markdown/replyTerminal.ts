import type { CreateTerminalOptions, TerminalAPI, TerminalShell } from '@/lib/api/types';
import { normalizeProjectActionCommand } from '@/lib/projectActionTerminal';
import { createTerminalTabId, useTerminalStore } from '@/stores/useTerminalStore';

type ReplyTerminalCreateOptions = Omit<
  Extract<CreateTerminalOptions, { mode: 'command' }>,
  'cwd' | 'sessionId' | 'mode' | 'command' | 'purpose' | 'shell' | 'loginShell'
>;

const TAGGED_SHELLS: ReadonlyMap<string, TerminalShell> = new Map([['bash', 'bash'], ['sh', 'sh'], ['zsh', 'zsh']]);

export const replyCommandShell = (language: string, configured: TerminalShell): TerminalShell => (
  TAGGED_SHELLS.get(language.toLowerCase()) ?? configured
);

export class ReplyTerminalUnsupportedError extends Error {}

export const startReplyTerminal = async ({ terminal, directory, command, shell, loginShells, createOptions, isCurrent }: {
  terminal: TerminalAPI;
  directory: string;
  command: string;
  shell: TerminalShell;
  loginShells: readonly TerminalShell[];
  createOptions: ReplyTerminalCreateOptions;
  isCurrent: () => boolean;
}): Promise<string | null> => {
  const session = await terminal.createSession({
    ...createOptions,
    cwd: directory,
    sessionId: createTerminalTabId(),
    mode: 'command',
    command: normalizeProjectActionCommand(command),
    purpose: { type: 'terminal' },
    shell,
    loginShell: loginShells.includes(shell),
  });
  if (session.mode !== 'command') {
    await terminal.close(session.sessionId, directory).catch(() => undefined);
    const store = useTerminalStore.getState();
    const adopted = store.getDirectoryState(directory)?.tabs.find((tab) => tab.terminalSessionId === session.sessionId);
    if (adopted) store.closeTab(directory, adopted.id);
    throw new ReplyTerminalUnsupportedError();
  }
  if (!isCurrent()) return null;

  const store = useTerminalStore.getState();
  const tabId = store.getDirectoryState(directory)?.tabs
    .find((tab) => tab.id === session.sessionId || tab.terminalSessionId === session.sessionId)?.id
    ?? store.createTab(directory, session.sessionId);
  store.setTabSessionId(directory, tabId, session.sessionId, { mode: 'command' });
  store.setTabLifecycle(directory, tabId, session.status === 'running' ? 'running' : 'exited');
  store.setActiveTab(directory, tabId);
  return tabId;
};
