import type * as vscode from 'vscode';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export type OpenCodeDebugInfo = {
  mode: 'managed' | 'external';
  status: ConnectionStatus;
  lastError?: string;
  workingDirectory: string;
  cliAvailable: boolean;
  cliPath: string | null;
  configuredApiUrl: string | null;
  configuredPort: number | null;
  detectedPort: number | null;
  apiPrefix: string;
  apiPrefixDetected: boolean;
  startCount: number;
  restartCount: number;
  lastStartAt: number | null;
  lastConnectedAt: number | null;
  lastExitCode: number | null;
  serverUrl: string | null;
  lastReadyElapsedMs: number | null;
  lastReadyAttempts: number | null;
  lastStartAttempts: number | null;
  version: string | null;
  secureConnection: boolean;
  authSource: 'user-env' | 'generated' | 'rotated' | null;
};

export type SetWorkingDirectoryResult =
  | { success: true; path: string }
  | { success: false; error: string };

export type StatusChangeMeta = {
  cliAvailable: boolean;
};

export interface OpenCodeManager {
  start(workdir?: string): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  setWorkingDirectory(path: string): Promise<SetWorkingDirectoryResult>;
  getStatus(): ConnectionStatus;
  getApiUrl(): string | null;
  getOpenCodeAuthHeaders(): Record<string, string>;
  getWorkingDirectory(): string;
  isCliAvailable(): boolean;
  getDebugInfo(): OpenCodeDebugInfo;
  onStatusChange(
    callback: (status: ConnectionStatus, error?: string, meta?: StatusChangeMeta) => void
  ): vscode.Disposable;
}

export type ReadyResult =
  | { ok: true; baseUrl: string; elapsedMs: number; attempts: number; version: string | null }
  | { ok: false; elapsedMs: number; attempts: number; version: null };
