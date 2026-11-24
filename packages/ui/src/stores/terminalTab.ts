export type TerminalTabLifecycle = 'idle' | 'starting' | 'running' | 'stopping' | 'exited';

export type TerminalTabPurpose =
  | { type: 'terminal' }
  | { type: 'project-action'; actionId: string; executionId: string | null; agentSessionId?: string };

export type TerminalTab = {
  id: string;
  terminalSessionId: string | null;
  mode?: 'interactive' | 'command';
  lifecycle: TerminalTabLifecycle;
  purpose: TerminalTabPurpose;
  label: string;
  iconKey: string | null;
  isConnecting: boolean;
  createdAt: number;
  previewUrl: string | null;
  previewAutoOpened: boolean;
  previewUrlLocked: boolean;
};
