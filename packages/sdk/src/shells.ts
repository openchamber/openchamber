export const GUEST_SHELL_ID_MAX = 128;
export const GUEST_SHELLS_MAX = 200;
export const GUEST_SHELL_OUTPUT_TAIL_MAX = 65536;

/** A shell command still running on behalf of a session. */
export type GuestRunningShell = {
  id: string;
  sessionID: string;
  command: string;
  startedAt: number;
  /** True for a job the turn does not wait for; false while the turn that ran it is blocked on it. */
  background: boolean;
};

export const GUEST_SHELL_END_STATUSES = ['exited', 'timeout', 'killed', 'stopped', 'unknown'] as const;

/**
 * How a shell command ended: `exited` on its own (see `exit`), `timeout`,
 * `killed` by a signal, `stopped` by a user (Stop, or aborting the turn that
 * waited on it), or `unknown` when
 * OpenChamber missed the end (a reconnect) and only saw the command gone.
 */
export type GuestShellEndStatus = (typeof GUEST_SHELL_END_STATUSES)[number];

/** A shell command OpenChamber saw running that has since ended. */
export type GuestEndedShell = GuestRunningShell & {
  status: GuestShellEndStatus;
  /** Exit code, when the command exited and OpenCode reported one. */
  exit?: number;
  endedAt: number;
};

/**
 * Which running shells a subscription covers: one session and its subagents,
 * every session of a registered project, or every session the app sees.
 */
export type GuestShellsScope =
  | { kind: 'session'; sessionId: string }
  | { kind: 'project'; projectId: string }
  | { kind: 'global' };

export type GuestRunningShellsSnapshot = {
  kind: 'shells';
  /** Echo of the scope the subscription asked for. */
  scope: GuestShellsScope;
  shells: GuestRunningShell[];
  /**
   * Commands in scope that ended since OpenChamber started watching, oldest
   * end first. Kept in memory only: empty after an app reload or runtime
   * switch, and capped at `GUEST_SHELLS_MAX`, newest kept.
   */
  ended: GuestEndedShell[];
};

export type GuestShellsSubscription = { subscriptionId: string; scope: GuestShellsScope };
export type GuestShellOutputRequest = { shellId: string; cursor?: number; tailBytes?: number };
export type GuestShellOutputResult = { output: string; cursor: number; skipped: boolean };
export type GuestShellStopResult = { stopped: true };
