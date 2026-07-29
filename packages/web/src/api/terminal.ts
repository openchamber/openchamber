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

  async createSession(options: CreateTerminalOptions): Promise<TerminalSession> {
    return createTerminalSession(options);
  },

  connect(sessionId: string, handlers: TerminalHandlers) {
    const unsubscribe = connectTerminalStream(
      sessionId,
      handlers.onEvent,
      handlers.onError
    );

    return {
      close: () => unsubscribe(),
    };
  },

  async sendInput(sessionId: string, input: string): Promise<void> {
    await sendTerminalInput(sessionId, input);
  },

  async resize(payload: ResizeTerminalPayload): Promise<void> {
    await resizeTerminal(payload.sessionId, payload.cols, payload.rows);
  },

  async updateAppearance(sessionId, appearance): Promise<void> {
    await updateTerminalAppearance(sessionId, appearance);
  },

  async close(sessionId: string): Promise<void> {
    await closeTerminal(sessionId);
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
