const ENABLED_VALUES = new Set(['1', 'true']);
const ALLOWED_PHASES = new Set([
  'web.pipeline.start',
  'web.listener.ready',
  'opencode.bootstrap.start',
  'opencode.bootstrap.ready',
  'opencode.bootstrap.error',
  'opencode.orphan-reap.ready',
  'opencode.attempt.start',
  'opencode.binary.ready',
  'opencode.environment.ready',
  'opencode.process.ready',
  'opencode.health.ready',
  'opencode.attempt.error',
  'proxy.readiness-hold',
]);
type OptionalLabelLookup = Pick<ReadonlySet<string | undefined>, 'has'>;
const ALLOWED_OUTCOMES: OptionalLabelLookup = new Set(['ready', 'timeout', 'aborted', 'error']);
const ALLOWED_ROUTE_CLASSES: OptionalLabelLookup = new Set(['session-messages', 'session', 'events', 'other']);

export interface StartupPerformanceDetails {
  durationMs?: number;
  totalDurationMs?: number;
  attempt?: number;
  outcome?: string;
  routeClass?: string;
}

interface StartupPerformanceEvent extends Omit<StartupPerformanceDetails, 'outcome' | 'routeClass'> {
  phase: string;
  at: number;
  outcome?: string | undefined;
  routeClass?: string | undefined;
}

const finiteNonNegative = (value: number | undefined) =>
  Number.isFinite(value) && value !== undefined && value >= 0 ? value : undefined;
const nonNegativeInteger = (value: number | undefined) =>
  Number.isInteger(value) && value !== undefined && value >= 0 ? value : undefined;

const isStartupPerformanceEnabled = () => (
  ENABLED_VALUES.has(String(process.env.OPENCHAMBER_STARTUP_PERF ?? '').toLowerCase())
);

export const recordStartupPerformance = (phase: string, details: StartupPerformanceDetails = {}) => {
  if (!isStartupPerformanceEnabled() || !ALLOWED_PHASES.has(phase)) return;

  const event: StartupPerformanceEvent = {
    phase,
    at: Date.now(),
  };
  const durationMs = finiteNonNegative(details.durationMs);
  const totalDurationMs = finiteNonNegative(details.totalDurationMs);
  const attempt = nonNegativeInteger(details.attempt);
  if (durationMs !== undefined) event.durationMs = durationMs;
  if (totalDurationMs !== undefined) event.totalDurationMs = totalDurationMs;
  if (attempt !== undefined) event.attempt = attempt;
  if (ALLOWED_OUTCOMES.has(details.outcome)) event.outcome = details.outcome;
  if (ALLOWED_ROUTE_CLASSES.has(details.routeClass)) event.routeClass = details.routeClass;

  console.info('[startup-performance]', event);
};
