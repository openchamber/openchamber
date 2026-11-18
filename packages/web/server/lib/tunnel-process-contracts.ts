export type TunnelAvailability =
  | { available: true; path: string; version: string | null }
  | { available: false; path: string | null; version: null };

export interface TunnelReachabilityOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function interruptTunnelProcess(child: ChildProcess) {
  try {
    child.kill('SIGINT');
  } catch {
    return;
  }
}
import type { ChildProcess } from 'node:child_process';
