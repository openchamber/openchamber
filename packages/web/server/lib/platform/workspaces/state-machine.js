// Workspace lifecycle state machine (plan section 8.2).
//
//   stopped  --> starting  (start / rebuild retry)
//   starting --> running   (runtime ready)
//   starting --> error     (start failed)
//   running  --> stopping  (stop)
//   stopping --> stopped   (runtime terminated)
//   stopping --> error     (stop failed)
//   error    --> starting  (retry after reconciliation)
//   error    --> stopped   (cleanup completed)
//
// desired_state (started|stopped) records user/admin intent; observed_state
// records what the runtime driver last reported. The worker may only move
// observed_state; the API moves it to starting/stopping when it registers the
// matching operation, and to error via reconciliation.

export const WORKSPACE_STATES = Object.freeze({
  STOPPED: 'stopped',
  STARTING: 'starting',
  RUNNING: 'running',
  STOPPING: 'stopping',
  ERROR: 'error',
});

export const DESIRED_STATES = Object.freeze(['started', 'stopped']);

const OBSERVED_TRANSITIONS = Object.freeze({
  stopped: ['starting'],
  // `stopping` is reachable from `starting` as well: a stop may be requested
  // while the environment is still starting (plan section 8.5 admin stop is
  // not limited to running environments).
  starting: ['running', 'error', 'stopping'],
  running: ['stopping'],
  stopping: ['stopped', 'error'],
  error: ['starting', 'stopped'],
});

export function isWorkspaceState(state) {
  return Object.values(WORKSPACE_STATES).includes(state);
}

// Identity (from === to) counts as reachable: a concurrent operation of
// another kind may re-assert the current state in its atomic conditional
// bump (e.g. a rebuild re-asserting `starting` while a start is in flight).
// What must never happen is a backwards or diagram-invalid jump
// (e.g. running -> stopped without stopping, starting -> stopped).
export function canReachObservedState(from, to) {
  if (!isWorkspaceState(from) || !isWorkspaceState(to)) return false;
  if (from === to) return true;
  return OBSERVED_TRANSITIONS[from].includes(to);
}

export function nextObservedStates(state) {
  return OBSERVED_TRANSITIONS[state] ?? [];
}

export function assertObservedTransition(from, to) {
  if (!canReachObservedState(from, to)) {
    throw new Error(`invalid workspace observed_state transition: ${from} -> ${to}`);
  }
}
