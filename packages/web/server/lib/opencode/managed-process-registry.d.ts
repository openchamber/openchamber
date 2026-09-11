export function registerManagedProcess(entry: {
  pid?: number;
  ownerPid?: number;
  port?: number | null;
  binary?: string | null;
  runtime?: string;
}): Promise<void>;

export function unregisterManagedProcess(pid?: number): Promise<void>;

export function reapOrphanedProcesses(options?: {
  log?: (message: string) => void;
}): Promise<{ inspected: number; reaped: number }>;
