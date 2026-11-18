export interface SessionActivityOptions {
  buildOpenCodeUrl(route: string, directory: string): string | URL;
  getOpenCodeAuthHeaders(): Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal | undefined;
}

export interface RunningSessionShell {
  sessionID: string;
  command: string;
  startedAt: number;
}

export interface RunningSessionJob {
  kind: string;
  sessionID: string;
  command: string | undefined;
  startedAt: number;
}

export interface SessionActivityProbe {
  fetchActiveSessionStatuses(): Promise<JsonObject | null>;
  hasWorkingChildren(sessionId: string, statuses: JsonObject): Promise<boolean | null>;
  hasWorkingDescendants(sessionId: string, statuses: JsonObject): Promise<boolean | null>;
  fetchRunningShells(directory: string): Promise<RunningSessionShell[] | null>;
  fetchRunningBackgroundJobs(sessionId: string): Promise<RunningSessionJob[] | null | undefined>;
}

export function createSessionActivityProbe(options: SessionActivityOptions): SessionActivityProbe;
import type { JsonObject } from '../shared/json-values.js';
