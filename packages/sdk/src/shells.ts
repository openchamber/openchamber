export const GUEST_SHELL_ID_MAX = 128;
export const GUEST_SHELLS_MAX = 200;
export const GUEST_SHELL_OUTPUT_TAIL_MAX = 65536;

export type GuestRunningShell = {
  id: string;
  sessionID: string;
  command: string;
  startedAt: number;
  background: boolean;
};

export const GUEST_SHELL_END_STATUSES = ['exited', 'timeout', 'killed', 'stopped', 'unknown'] as const;

export type GuestShellEndStatus = (typeof GUEST_SHELL_END_STATUSES)[number];

export type GuestEndedShell = GuestRunningShell & {
  status: GuestShellEndStatus;
  exit?: number;
  endedAt: number;
};

export type GuestShellsScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'global' };

export type GuestRunningShellsSnapshot = {
  kind: 'shells';
  scope: GuestShellsScope;
  shells: GuestRunningShell[];
  ended: GuestEndedShell[];
};

export type GuestShellsSubscription = { subscriptionId: string; scope: GuestShellsScope };
export type GuestShellOutputRequest = { shellId: string; cursor?: number; tailBytes?: number };
export type GuestShellOutputResult = { output: string; cursor: number; skipped: boolean };
export type GuestShellStopResult = { stopped: true };
