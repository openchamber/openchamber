import {
  connectTerminalStream,
  createTerminalSession,
  resizeTerminal,
  updateTerminalAppearance,
  sendTerminalInput,
  closeTerminal,
  restartTerminalSession,
  forceKillTerminal,
  listTerminalShells,
  listTerminalSessions,
  touchTerminalSessions,
} from '@openchamber/ui/lib/terminalApi';
import type {
  TerminalAPI,
  TerminalHandlers,
  CreateTerminalOptions,
  ResizeTerminalPayload,
  TerminalSession,
  ForceKillOptions,
} from '@openchamber/ui/lib/api/types';

export const createWebTerminalAPI = (): TerminalAPI => ({
  async listShells() {
    return listTerminalShells();
  },

  async listSessions(cwd: string) {
    return listTerminalSessions(cwd);
  },

  async touchSessions(sessionIds: string[], directory?: string | null) {
    await touchTerminalSessions(sessionIds, directory);
  },

  async createSession(options: CreateTerminalOptions): Promise<TerminalSession> {
    return createTerminalSession(options);
  },

  connect(sessionId: string, handlers: TerminalHandlers, directory?: string | null) {
    const unsubscribe = connectTerminalStream(
      sessionId,
      handlers.onEvent,
      handlers.onError,
      directory,
    );

    return {
      close: () => unsubscribe(),
    };
  },

  async sendInput(sessionId: string, input: string, directory?: string | null): Promise<void> {
    await sendTerminalInput(sessionId, input, directory);
  },

  async resize(payload: ResizeTerminalPayload): Promise<void> {
    await resizeTerminal(payload.sessionId, payload.cols, payload.rows, payload.directory);
  },

  async updateAppearance(sessionId, appearance, directory?: string | null): Promise<void> {
    await updateTerminalAppearance(sessionId, appearance, directory);
  },

  async close(sessionId: string, directory?: string | null): Promise<void> {
    await closeTerminal(sessionId, directory);
  },

  async restartSession(
    currentSessionId: string,
    options: CreateTerminalOptions
  ): Promise<TerminalSession> {
    return restartTerminalSession(currentSessionId, {
      cwd: options.cwd ?? '',
      cols: options.cols,
      rows: options.rows,
      themeMode: options.themeMode,
      terminalBackground: options.terminalBackground,
      terminalForeground: options.terminalForeground,
      shell: options.shell,
      loginShell: options.loginShell,
    });
  },

  async forceKill(options: ForceKillOptions): Promise<void> {
    await forceKillTerminal(options);
  },
});
