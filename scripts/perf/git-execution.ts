/**
 * Standalone Git execution performance validation for issue #2233.
 *
 * Reports JSON to stdout and writes no file unless --output is explicit.
 * Real Git is confined to disposable local repositories and bare remotes.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export type GitExecutionProfile = 'pr-real' | 'target-real' | 'soak' | 'cap-sweep';

type OperationKind = 'read' | 'worktree-write' | 'common-write' | 'topology-write';
type ScenarioName =
  | 'startup'
  | 'pathological-fanout'
  | 'fairness'
  | 'local-fetch'
  | 'lock-recovery'
  | 'mixed-workload'
  | 'soak'
  | 'cap-sweep';

const GIT_COMMAND_CATEGORIES = [
  'environment',
  'fixture-setup',
  'discovery',
  'workload',
  'lock-recovery',
  'cleanup',
] as const;

type GitCommandCategory = typeof GIT_COMMAND_CATEGORIES[number];

type ScenarioCounters = {
  logicalCallers: number;
  coordinatorApiSubmissions: number;
  underlyingScheduledOperations: number;
  gitCommands: number;
};

type EntityMappingEvidence = {
  applicable: boolean;
  sessionEntities: number;
  worktreeIdentities: number;
  coordinatorApiSubmissions: number;
  underlyingScheduledOperations: number;
  gitCommands: number;
};

type GitCommandExpectation = {
  byCategory: Record<GitCommandCategory, number>;
  byClass: Record<string, number>;
  total: number;
  expectedSuccesses: number;
  expectedFailures: number;
  equation: string;
};

type SafetyGuardName =
  | 'fixture-path-boundary'
  | 'child-cwd-boundary'
  | 'child-path-operands'
  | 'child-environment'
  | 'child-git-configuration'
  | 'local-remote-policy'
  | 'output-boundary';

type SafetyGuardCounts = Record<SafetyGuardName, { passed: number; failed: number }>;

type HarnessSafetyReport = {
  passed: boolean;
  fixtureBoundary: 'unique-os-temp-directory';
  outputBoundary: {
    mode: 'stdout-only' | 'explicit-single-file';
    policy: 'no-file-written' | 'canonical-path-outside-workspace';
  };
  guards: SafetyGuardCounts;
  evidence: {
    childCwdChecksEqualGitCommands: boolean;
    childPathChecksEqualGitCommands: boolean;
    childEnvironmentChecksEqualGitCommands: boolean;
    childConfigurationChecksEqualGitCommands: boolean;
    remotePolicyChecksEqualGitCommands: boolean;
    failedGuardCodes: string[];
  };
  directChildAccountingCaveat: string;
};

type ExecutionContext = {
  isRepository: true;
  commonId: string;
  worktreeId: string;
  requestedDirectory?: string;
  topLevel?: string;
  gitDir?: string;
  commonDir?: string;
};

type CoordinatorStats = {
  active: number;
  pending: number;
  activeNetwork: number;
  contexts: number;
  idleContexts: number;
  worktrees: number;
  statusInFlight: number;
  clonePending: number;
  cloneDestinations: number;
  limits: {
    globalConcurrency: number;
    readsPerCommonContext: number;
    networkPerCommonContext: number;
    globalNetworkConcurrency: number;
    maxQueuePerContext: number;
    maxGlobalQueue: number;
    maxContexts: number;
    maxWorktrees: number;
    maxStatusInFlight: number;
    maxCloneQueue: number;
    maxCloneQueuePerDestination: number;
    maxCloneDestinations: number;
    idleTtlMs: number;
    idlePruneIntervalMs: number;
  };
};

type CoordinatorLike = {
  run: <T>(
    options: {
      context: ExecutionContext;
      kind: OperationKind;
      targetWorktree?: boolean;
      network?: boolean;
      label?: string;
      queueTimeoutMs?: number;
    },
    task: () => Promise<T> | T,
  ) => Promise<T>;
  runStatus: <T>(
    options: {
      context: ExecutionContext;
      shape?: 'full' | 'light';
      label?: string;
      queueTimeoutMs?: number;
    },
    task: (shape: 'full' | 'light') => Promise<T> | T,
  ) => Promise<T>;
  getGeneration: (context: ExecutionContext) => { common: number; worktree: number };
  getStats: () => CoordinatorStats;
  pruneIdle: (options?: { force?: boolean }) => void;
};

type ResolverStats = {
  inFlightAliases: number;
  maxInFlightAliases: number;
  inFlightContexts: number;
  maxInFlightContexts: number;
  discovery: {
    active: number;
    pending: number;
    concurrency: number;
    maxPending: number;
  };
};

type ResolverLike = {
  resolve: (directory: string) => Promise<ExecutionContext | { isRepository: false }>;
  getStats: () => ResolverStats;
};

type CoordinatorModule = {
  GIT_OPERATION_KIND: {
    READ: OperationKind;
    WORKTREE_WRITE: OperationKind;
    COMMON_WRITE: OperationKind;
    TOPOLOGY_WRITE: OperationKind;
  };
  createGitExecutionCoordinator: (options?: Record<string, unknown>) => CoordinatorLike;
};

type ResolverModule = {
  createGitContextResolver: (options: {
    runGit: (cwd: string, args: string[]) => Promise<{
      success: boolean;
      exitCode: number;
      stdout: string;
      stderr: string;
    }>;
    realpath?: (value: string) => Promise<string>;
  }) => ResolverLike;
};

type TimingSample = {
  queueMs: number;
  serviceMs: number;
  totalMs: number;
};

type Distribution = {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

type TimingDistribution = {
  queueMs: Distribution;
  serviceMs: Distribution;
  totalMs: Distribution;
};

type AssertionResult = {
  name: string;
  passed: boolean;
  expected?: unknown;
  actual?: unknown;
};

type ProfileConfig = {
  development: boolean;
  gitChildTimeoutMs: number;
  sessionRecords: number;
  commonDirectories: number;
  linkedWorktrees: number;
  worktreeIdentities: number;
  startupCallers: number;
  fanoutCallers: number;
  mutations: number;
  fetches: number;
  durationMs: number;
  rate: number;
  caps: number[];
};

type GitChildTimeoutProbe = {
  operationClass: string;
  ignoreSigterm?: boolean;
  terminationGraceMs?: number;
};

export type GitExecutionRunOptions = {
  profile?: GitExecutionProfile;
  seed?: number;
  development?: boolean;
  gitChildTimeoutMs?: number;
  durationMs?: number;
  rate?: number;
  output?: string;
  human?: boolean;
  testHooks?: {
    /** Programmatic regression seam; intentionally unavailable through the CLI. */
    soakStatusDelayPatternMs?: readonly number[];
    /** Replaces the first matching Git child with a harness-owned timeout probe. */
    gitChildTimeoutProbe?: GitChildTimeoutProbe;
  };
};

export type GitExecutionReport = {
  schemaVersion: 2;
  profile: GitExecutionProfile;
  seed: number;
  passed: boolean;
  durationMs: number;
  config: ProfileConfig;
  environment: {
    platform: NodeJS.Platform;
    architecture: string;
    gitVersion: string;
    bunVersion: string | null;
    nodeVersion: string;
    cpuCount: number;
    fdMeasurement: 'linux-procfs' | 'unsupported';
    gitChildScope: string;
    cpuScope: string;
  };
  cardinality: {
    sessionEntities: number;
    uniqueCommonDirectories: number;
    uniqueWorktreeIdentities: number;
    entityMapping: EntityMappingEvidence;
    scenarios: Record<string, ScenarioCounters>;
    coordinatorApiSubmissions: number;
    underlyingScheduledOperations: number;
    gitCommands: number;
  };
  operations: {
    coordinatorApiSubmissionsByClass: Record<string, number>;
    underlyingScheduledOperationsByClass: Record<string, number>;
    gitCommandsByCategory: Record<GitCommandCategory, number>;
    gitCommandsByClass: Record<string, number>;
    gitCommandAccounting: {
      closedCategories: GitCommandCategory[];
      expectedByCategory: Record<GitCommandCategory, number>;
      observedCategorySum: number;
      expectedByClass: Record<string, number>;
      observedClassSum: number;
      expectedTotal: number;
      expectedSuccesses: number;
      expectedFailures: number;
      equation: string;
    };
    gitCommandSuccesses: number;
    gitCommandFailures: number;
    statusWaiters: number;
    statusUnderlyingScheduledOperations: number;
  };
  latency: {
    contract: {
      underlyingScheduledOperations: 'one queue/service/total sample per task that actually starts';
      allWaitersObservedTotalMs: 'one exact observed-total sample per coordinator API submission';
    };
    underlyingScheduledOperations: Record<string, TimingDistribution>;
    allWaitersObservedTotalMs: Record<string, Distribution>;
  };
  safety: HarnessSafetyReport;
  peaks: {
    topLevelOperations: number;
    coordinatorActive: number;
    coordinatorPending: number;
    globalReads: number;
    perContextReads: number;
    globalNetwork: number;
    perContextNetwork: number;
    statusInFlight: number;
    harnessGitChildren: number;
  };
  resources: {
    cpuUserMicros: number;
    cpuSystemMicros: number;
    rssBytes: { start: number; peak: number; end: number };
    heapBytes: { start: number; peak: number; end: number };
    fd: { start: number | null; end: number | null; tolerance: number };
    eventLoopDelayMs: { p50: number | null; p95: number | null; p99: number | null; max: number | null };
  };
  lifecycle: {
    generationTotal: number;
    expectedGenerationMovement: number;
    expectedErrors: number;
    unexpectedErrors: number;
    overloads: number;
    lockFailures: number;
    lockRetries: number;
    gitChildTimeouts: number;
    gitChildTerminationAttempts: number;
    gitChildGracefulTerminations: number;
    gitChildForcedTerminations: number;
    gitChildReapedAfterTimeout: number;
    retainedBeforeEviction: { contexts: number; worktrees: number };
    finalCoordinator: CoordinatorStats | null;
    finalResolver: ResolverStats | null;
    activeHarnessSubmissions: number;
    activeHarnessGitChildren: number;
    fixtureCleanupSucceeded: boolean;
  };
  details: Record<string, unknown>;
  assertions: AssertionResult[];
};

const TARGET_DEFAULTS = Object.freeze({
  sessionRecords: 30_000,
  commonDirectories: 200,
  linkedWorktrees: 100,
  worktreeIdentities: 300,
  startupCallers: 300,
  fanoutCallers: 30_000,
  mutations: 600,
  fetches: 60,
});

const DEVELOPMENT_TARGET_DEFAULTS = Object.freeze({
  sessionRecords: 600,
  commonDirectories: 4,
  linkedWorktrees: 2,
  worktreeIdentities: 6,
  startupCallers: 6,
  fanoutCallers: 600,
  mutations: 12,
  fetches: 3,
});

export const PROFILE_DEFAULTS = Object.freeze({
  seed: 0x2233,
  gitChildTimeoutMs: 60_000,
  prReal: Object.freeze({
    sessionRecords: 30,
    commonDirectories: 1,
    linkedWorktrees: 1,
    worktreeIdentities: 2,
  }),
  targetReal: TARGET_DEFAULTS,
  targetRealDevelopment: DEVELOPMENT_TARGET_DEFAULTS,
  soak: Object.freeze({
    durationMs: 300_000,
    rate: 20,
    commonDirectories: 4,
    linkedWorktrees: 2,
  }),
  capSweep: Object.freeze({ caps: Object.freeze([2, 4, 6, 8, 12]) }),
});

const FD_TOLERANCE = 3;
const GIT_CHILD_TERMINATION_GRACE_MS = 1_000;
const JSON_INDENT = 2;
const WORKSPACE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const round = (value: number, digits = 3): number => {
  if (!Number.isFinite(value)) return 0;
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const percentile = (values: number[], percentileValue: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return round(sorted[index] ?? 0);
};

const distribution = (values: number[]): Distribution => ({
  count: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  p99: percentile(values, 99),
  max: round(values.length > 0 ? Math.max(...values) : 0),
});

const incrementRecord = (record: Record<string, number>, key: string, amount = 1): void => {
  record[key] = (record[key] ?? 0) + amount;
};

const createGitCommandCategoryRecord = (): Record<GitCommandCategory, number> => ({
  environment: 0,
  'fixture-setup': 0,
  discovery: 0,
  workload: 0,
  'lock-recovery': 0,
  cleanup: 0,
});

const sumRecord = (record: Record<string, number>): number => (
  Object.values(record).reduce((total, value) => total + value, 0)
);

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 0x1_0000_0000;
  }

  integer(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  shuffle<T>(values: T[]): T[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const target = this.integer(index + 1);
      [result[index], result[target]] = [result[target]!, result[index]!];
    }
    return result;
  }
}

class AssertionCollector {
  readonly results: AssertionResult[] = [];

  equal(name: string, actual: unknown, expected: unknown): void {
    this.results.push({ name, passed: Object.is(actual, expected), expected, actual });
  }

  deepEqual(name: string, actual: unknown, expected: unknown): void {
    const actualJson = JSON.stringify(actual);
    const expectedJson = JSON.stringify(expected);
    this.results.push({
      name,
      passed: actualJson === expectedJson,
      expected: JSON.parse(expectedJson) as unknown,
      actual: JSON.parse(actualJson) as unknown,
    });
  }

  truthy(name: string, actual: unknown, expected: unknown = true): void {
    this.results.push({ name, passed: Boolean(actual), expected, actual });
  }

  atMost(name: string, actual: number, expected: number): void {
    this.results.push({ name, passed: actual <= expected, expected: `<= ${expected}`, actual });
  }

  get passed(): boolean {
    return this.results.every((result) => result.passed);
  }
}

class MetricsCollector {
  readonly underlyingTimings = new Map<string, TimingSample[]>();
  readonly waiterObservedTotals = new Map<string, number[]>();
  readonly submissionsByClass: Record<string, number> = {};
  readonly underlyingByClass: Record<string, number> = {};
  readonly gitCommandsByCategory = createGitCommandCategoryRecord();
  readonly gitCommandsByClass: Record<string, number> = {};
  readonly scenarios = new Map<ScenarioName, ScenarioCounters>();
  readonly activeReadsByCommon = new Map<string, number>();
  readonly activeNetworkByCommon = new Map<string, number>();
  sessionEntities = 0;
  entityMapping: EntityMappingEvidence = {
    applicable: false,
    sessionEntities: 0,
    worktreeIdentities: 0,
    coordinatorApiSubmissions: 0,
    underlyingScheduledOperations: 0,
    gitCommands: 0,
  };
  statusWaiters = 0;
  statusUnderlying = 0;
  coordinatorSubmissions = 0;
  activeSubmissions = 0;
  underlyingOperations = 0;
  gitCommands = 0;
  gitCommandSuccesses = 0;
  gitCommandFailures = 0;
  activeTopLevel = 0;
  peakTopLevel = 0;
  activeReads = 0;
  peakGlobalReads = 0;
  peakPerContextReads = 0;
  activeNetwork = 0;
  peakGlobalNetwork = 0;
  peakPerContextNetwork = 0;
  peakCoordinatorActive = 0;
  peakCoordinatorPending = 0;
  peakStatusInFlight = 0;
  activeGitChildren = 0;
  peakGitChildren = 0;
  expectedErrors = 0;
  unexpectedErrors = 0;
  overloads = 0;
  lockFailures = 0;
  lockRetries = 0;
  gitChildTimeouts = 0;
  gitChildTerminationAttempts = 0;
  gitChildGracefulTerminations = 0;
  gitChildForcedTerminations = 0;
  gitChildReapedAfterTimeout = 0;
  expectedGenerationMovement = 0;

  declareScenario(name: ScenarioName, logicalCallers: number): void {
    if (this.scenarios.has(name)) throw new Error(`Scenario ${name} was declared more than once`);
    this.scenarios.set(name, {
      logicalCallers,
      coordinatorApiSubmissions: 0,
      underlyingScheduledOperations: 0,
      gitCommands: 0,
    });
  }

  private scenario(name: ScenarioName): ScenarioCounters {
    const counters = this.scenarios.get(name);
    if (!counters) throw new Error(`Scenario ${name} must declare logical callers before work is submitted`);
    return counters;
  }

  workSnapshot(): { coordinatorApiSubmissions: number; underlyingScheduledOperations: number; gitCommands: number } {
    return {
      coordinatorApiSubmissions: this.coordinatorSubmissions,
      underlyingScheduledOperations: this.underlyingOperations,
      gitCommands: this.gitCommands,
    };
  }

  recordEntityMapping(
    applicable: boolean,
    sessionEntities: number,
    worktreeIdentities: number,
    before: { coordinatorApiSubmissions: number; underlyingScheduledOperations: number; gitCommands: number },
  ): void {
    const after = this.workSnapshot();
    this.sessionEntities = sessionEntities;
    this.entityMapping = {
      applicable,
      sessionEntities,
      worktreeIdentities,
      coordinatorApiSubmissions: after.coordinatorApiSubmissions - before.coordinatorApiSubmissions,
      underlyingScheduledOperations: after.underlyingScheduledOperations - before.underlyingScheduledOperations,
      gitCommands: after.gitCommands - before.gitCommands,
    };
  }

  submit(scenarioName: ScenarioName, operationClass: string, status = false): void {
    this.coordinatorSubmissions += 1;
    this.activeSubmissions += 1;
    this.scenario(scenarioName).coordinatorApiSubmissions += 1;
    incrementRecord(this.submissionsByClass, operationClass);
    if (status) this.statusWaiters += 1;
  }

  submissionFinished(): void {
    this.activeSubmissions -= 1;
  }

  startUnderlying(
    scenarioName: ScenarioName,
    operationClass: string,
    context: ExecutionContext,
    kind: OperationKind,
    network: boolean,
  ): void {
    this.underlyingOperations += 1;
    this.scenario(scenarioName).underlyingScheduledOperations += 1;
    incrementRecord(this.underlyingByClass, operationClass);
    if (operationClass.includes('status')) this.statusUnderlying += 1;
    if (kind !== 'read') this.expectedGenerationMovement += 2;
    this.activeTopLevel += 1;
    this.peakTopLevel = Math.max(this.peakTopLevel, this.activeTopLevel);
    if (kind === 'read') {
      this.activeReads += 1;
      this.peakGlobalReads = Math.max(this.peakGlobalReads, this.activeReads);
      const current = (this.activeReadsByCommon.get(context.commonId) ?? 0) + 1;
      this.activeReadsByCommon.set(context.commonId, current);
      this.peakPerContextReads = Math.max(this.peakPerContextReads, current);
    }
    if (network) {
      this.activeNetwork += 1;
      this.peakGlobalNetwork = Math.max(this.peakGlobalNetwork, this.activeNetwork);
      const current = (this.activeNetworkByCommon.get(context.commonId) ?? 0) + 1;
      this.activeNetworkByCommon.set(context.commonId, current);
      this.peakPerContextNetwork = Math.max(this.peakPerContextNetwork, current);
    }
  }

  finishUnderlying(context: ExecutionContext, kind: OperationKind, network: boolean): void {
    this.activeTopLevel -= 1;
    if (kind === 'read') {
      this.activeReads -= 1;
      const current = (this.activeReadsByCommon.get(context.commonId) ?? 1) - 1;
      if (current <= 0) this.activeReadsByCommon.delete(context.commonId);
      else this.activeReadsByCommon.set(context.commonId, current);
    }
    if (network) {
      this.activeNetwork -= 1;
      const current = (this.activeNetworkByCommon.get(context.commonId) ?? 1) - 1;
      if (current <= 0) this.activeNetworkByCommon.delete(context.commonId);
      else this.activeNetworkByCommon.set(context.commonId, current);
    }
  }

  recordUnderlyingTiming(operationClass: string, sample: TimingSample): void {
    const existing = this.underlyingTimings.get(operationClass) ?? [];
    existing.push(sample);
    this.underlyingTimings.set(operationClass, existing);
  }

  recordWaiterObservedTotal(operationClass: string, totalMs: number): void {
    const existing = this.waiterObservedTotals.get(operationClass) ?? [];
    existing.push(totalMs);
    this.waiterObservedTotals.set(operationClass, existing);
  }

  sampleCoordinator(stats: CoordinatorStats): void {
    this.peakCoordinatorActive = Math.max(this.peakCoordinatorActive, stats.active);
    this.peakCoordinatorPending = Math.max(this.peakCoordinatorPending, stats.pending);
    this.peakStatusInFlight = Math.max(this.peakStatusInFlight, stats.statusInFlight);
    this.peakGlobalNetwork = Math.max(this.peakGlobalNetwork, stats.activeNetwork);
  }

  gitChildStarted(): void {
    this.activeGitChildren += 1;
    this.peakGitChildren = Math.max(this.peakGitChildren, this.activeGitChildren);
  }

  gitChildFinished(): void {
    this.activeGitChildren -= 1;
  }

  gitCommandStarted(category: GitCommandCategory, operationClass: string, scenarioName: ScenarioName | null): void {
    this.gitCommands += 1;
    this.gitCommandsByCategory[category] += 1;
    incrementRecord(this.gitCommandsByClass, operationClass);
    if (scenarioName) this.scenario(scenarioName).gitCommands += 1;
  }

  scenarioReport(): Record<string, ScenarioCounters> {
    return Object.fromEntries([...this.scenarios.entries()].map(([name, counters]) => [name, { ...counters }]));
  }

  underlyingLatencyReport(): Record<string, TimingDistribution> {
    return Object.fromEntries([...this.underlyingTimings.entries()].map(([operationClass, samples]) => [
      operationClass,
      {
        queueMs: distribution(samples.map((sample) => sample.queueMs)),
        serviceMs: distribution(samples.map((sample) => sample.serviceMs)),
        totalMs: distribution(samples.map((sample) => sample.totalMs)),
      },
    ]));
  }

  waiterLatencyReport(): Record<string, Distribution> {
    return Object.fromEntries([...this.waiterObservedTotals.entries()].map(([operationClass, samples]) => [
      operationClass,
      distribution(samples),
    ]));
  }
}

const countLinuxFds = async (): Promise<number | null> => {
  if (process.platform !== 'linux') return null;
  try {
    return (await readdir('/proc/self/fd')).length;
  } catch {
    return null;
  }
};

class ResourceSampler {
  private readonly cpuStart = process.resourceUsage();
  private readonly memoryStart = process.memoryUsage();
  private memoryPeak = { rss: this.memoryStart.rss, heapUsed: this.memoryStart.heapUsed };
  private timer: NodeJS.Timeout | null = null;
  private eventLoop: ReturnType<typeof monitorEventLoopDelay> | null = null;
  private fdStart: number | null = null;

  async start(): Promise<void> {
    this.fdStart = await countLinuxFds();
    this.timer = setInterval(() => this.sampleMemory(), 10);
    this.timer.unref();
    try {
      this.eventLoop = monitorEventLoopDelay({ resolution: 10 });
      this.eventLoop.enable();
    } catch {
      this.eventLoop = null;
    }
  }

  private sampleMemory(): void {
    const current = process.memoryUsage();
    this.memoryPeak.rss = Math.max(this.memoryPeak.rss, current.rss);
    this.memoryPeak.heapUsed = Math.max(this.memoryPeak.heapUsed, current.heapUsed);
  }

  async finish(): Promise<GitExecutionReport['resources']> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sampleMemory();
    const memoryEnd = process.memoryUsage();
    const cpuEnd = process.resourceUsage();
    const fdEnd = await countLinuxFds();
    let eventLoopDelay: GitExecutionReport['resources']['eventLoopDelayMs'] = {
      p50: null,
      p95: null,
      p99: null,
      max: null,
    };
    if (this.eventLoop) {
      this.eventLoop.disable();
      const toMilliseconds = (value: number): number | null => (
        Number.isFinite(value) ? round(value / 1_000_000) : null
      );
      eventLoopDelay = {
        p50: toMilliseconds(this.eventLoop.percentile(50)),
        p95: toMilliseconds(this.eventLoop.percentile(95)),
        p99: toMilliseconds(this.eventLoop.percentile(99)),
        max: toMilliseconds(this.eventLoop.max),
      };
    }
    return {
      cpuUserMicros: cpuEnd.userCPUTime - this.cpuStart.userCPUTime,
      cpuSystemMicros: cpuEnd.systemCPUTime - this.cpuStart.systemCPUTime,
      rssBytes: { start: this.memoryStart.rss, peak: this.memoryPeak.rss, end: memoryEnd.rss },
      heapBytes: { start: this.memoryStart.heapUsed, peak: this.memoryPeak.heapUsed, end: memoryEnd.heapUsed },
      fd: { start: this.fdStart, end: fdEnd, tolerance: FD_TOLERANCE },
      eventLoopDelayMs: eventLoopDelay,
    };
  }
}

type GitCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

class GitCommandError extends Error {
  readonly result: GitCommandResult;

  constructor(args: string[], result: GitCommandResult) {
    super(`git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
    this.name = 'GitCommandError';
    this.result = result;
  }
}

class GitChildTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(args: string[], timeoutMs: number) {
    super(`git ${args.join(' ')} exceeded the harness child timeout of ${timeoutMs}ms`);
    this.name = 'GitChildTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

class ExpectedLockFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExpectedLockFailure';
  }
}

type GitRemoteDescriptor =
  | { kind: 'fixture-path'; value: string }
  | { kind: 'registered-alias'; value: string };

type GitRunOptions = {
  category: GitCommandCategory;
  operationClass: string;
  scenario: ScenarioName | null;
  paths: string[];
  remote: GitRemoteDescriptor | null;
  readOnly?: boolean;
  allowFailure?: boolean;
};

type OutputBoundary = {
  mode: 'stdout-only' | 'explicit-single-file';
  policy: 'no-file-written' | 'canonical-path-outside-workspace';
  canonicalOutputPath: string | null;
};

const createSafetyGuardCounts = (): SafetyGuardCounts => ({
  'fixture-path-boundary': { passed: 0, failed: 0 },
  'child-cwd-boundary': { passed: 0, failed: 0 },
  'child-path-operands': { passed: 0, failed: 0 },
  'child-environment': { passed: 0, failed: 0 },
  'child-git-configuration': { passed: 0, failed: 0 },
  'local-remote-policy': { passed: 0, failed: 0 },
  'output-boundary': { passed: 0, failed: 0 },
});

const isPathWithinOrEqual = (boundary: string, candidate: string): boolean => {
  const relative = path.relative(boundary, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const resolveOutputBoundary = async (output: string | undefined): Promise<OutputBoundary> => {
  if (!output) {
    return { mode: 'stdout-only', policy: 'no-file-written', canonicalOutputPath: null };
  }
  const requestedPath = path.resolve(output);
  if (existsSync(requestedPath)) throw new Error('--output must name a new file; existing files are never overwritten');
  const workspaceRoot = await realpath(WORKSPACE_ROOT);
  const canonicalOutputPath = path.join(await realpath(path.dirname(requestedPath)), path.basename(requestedPath));
  if (isPathWithinOrEqual(workspaceRoot, canonicalOutputPath)) {
    throw new Error('--output must resolve outside the project workspace');
  }
  return {
    mode: 'explicit-single-file',
    policy: 'canonical-path-outside-workspace',
    canonicalOutputPath,
  };
};

class HarnessSafetyGuard {
  private readonly root: string;
  private readonly hooksDirectory: string;
  private readonly globalConfig: string;
  private readonly outputBoundary: OutputBoundary;
  private readonly counts = createSafetyGuardCounts();
  private readonly failedGuardCodes: string[] = [];
  private readonly localRemotes = new Map<string, Map<string, string>>();

  constructor(root: string, hooksDirectory: string, globalConfig: string, outputBoundary: OutputBoundary) {
    this.root = path.resolve(root);
    this.hooksDirectory = path.resolve(hooksDirectory);
    this.globalConfig = path.resolve(globalConfig);
    this.outputBoundary = outputBoundary;
    this.pass('output-boundary');
  }

  private pass(name: SafetyGuardName): void {
    this.counts[name].passed += 1;
  }

  private fail(name: SafetyGuardName, code: string): never {
    this.counts[name].failed += 1;
    this.failedGuardCodes.push(code);
    throw new Error(`Harness safety guard failed: ${code}`);
  }

  private resolveCandidate(value: string, cwd = this.root): string {
    return path.resolve(cwd, value);
  }

  assertFixturePath(value: string, code: string, cwd = this.root): string {
    const candidate = this.resolveCandidate(value, cwd);
    if (!isPathWithinOrEqual(this.root, candidate)) this.fail('fixture-path-boundary', code);
    this.pass('fixture-path-boundary');
    return candidate;
  }

  registerLocalRemote(cwd: string, alias: string, target: string): void {
    const checkedCwd = this.assertFixturePath(cwd, 'remote-registration-cwd');
    const checkedTarget = this.assertFixturePath(target, 'remote-registration-target');
    const aliases = this.localRemotes.get(checkedCwd) ?? new Map<string, string>();
    aliases.set(alias, checkedTarget);
    this.localRemotes.set(checkedCwd, aliases);
  }

  private expectedPathOperands(args: string[]): string[] {
    const command = args[0];
    if (command === 'add') {
      const separator = args.indexOf('--');
      if (separator < 0) this.fail('child-path-operands', 'add-missing-path-separator');
      return args.slice(separator + 1);
    }
    if (command === 'clone') return [args.at(-1)!];
    if (command === 'worktree') {
      if (args[1] === 'add') return [args.at(-2)!];
      if (args[1] === 'remove') return [args.at(-1)!];
      this.fail('child-path-operands', 'unsupported-worktree-command');
    }
    if (command === 'config' && args[1] === 'core.hooksPath') return [args[2]!];
    if (['--version', 'config', 'init', 'symbolic-ref', 'commit', 'rev-parse', 'status', 'diff', 'fetch'].includes(command ?? '')) {
      return [];
    }
    this.fail('child-path-operands', `unsupported-git-command-${command ?? 'missing'}`);
  }

  private assertPathOperands(cwd: string, args: string[], declaredPaths: string[]): void {
    const expected = this.expectedPathOperands(args).map((value) => this.resolveCandidate(value, cwd)).sort();
    const declared = declaredPaths.map((value) => this.resolveCandidate(value, cwd)).sort();
    for (const candidate of declared) {
      if (!isPathWithinOrEqual(this.root, candidate)) this.fail('child-path-operands', 'child-path-outside-fixture');
    }
    if (JSON.stringify(expected) !== JSON.stringify(declared)) {
      this.fail('child-path-operands', 'child-path-metadata-mismatch');
    }
    this.pass('child-path-operands');
  }

  private assertEnvironment(env: NodeJS.ProcessEnv, readOnly: boolean): void {
    const allowedSensitiveKeys = new Set([
      'GIT_CONFIG_NOSYSTEM',
      'GIT_CONFIG_GLOBAL',
      'GIT_TERMINAL_PROMPT',
      'GIT_ATTR_NOSYSTEM',
      'GIT_PAGER',
      'GIT_AUTHOR_DATE',
      'GIT_COMMITTER_DATE',
      'GIT_OPTIONAL_LOCKS',
      'GCM_INTERACTIVE',
      'SSH_ASKPASS_REQUIRE',
    ]);
    const unexpected = Object.keys(env).filter((key) => (
      (key.startsWith('GIT_') || key.startsWith('GCM_') || key.startsWith('SSH_ASKPASS'))
      && !allowedSensitiveKeys.has(key)
    ));
    const valid = unexpected.length === 0
      && env.GIT_CONFIG_NOSYSTEM === '1'
      && env.GIT_CONFIG_GLOBAL === this.globalConfig
      && isPathWithinOrEqual(this.root, env.GIT_CONFIG_GLOBAL)
      && env.GIT_TERMINAL_PROMPT === '0'
      && env.GCM_INTERACTIVE === 'Never'
      && env.SSH_ASKPASS_REQUIRE === 'never'
      && env.GIT_ATTR_NOSYSTEM === '1'
      && env.GIT_PAGER === 'cat'
      && env.SSH_AUTH_SOCK === undefined
      && env.SSH_AGENT_PID === undefined
      && (readOnly ? env.GIT_OPTIONAL_LOCKS === '0' : env.GIT_OPTIONAL_LOCKS === undefined);
    if (!valid) this.fail('child-environment', 'child-environment-policy');
    this.pass('child-environment');
  }

  private assertGitConfiguration(gitArgs: string[]): void {
    const expectedPrefix = [
      '-c', `core.hooksPath=${this.hooksDirectory}`,
      '-c', 'gc.auto=0',
      '-c', 'maintenance.auto=false',
    ];
    if (JSON.stringify(gitArgs.slice(0, expectedPrefix.length)) !== JSON.stringify(expectedPrefix)) {
      this.fail('child-git-configuration', 'child-git-configuration-policy');
    }
    this.pass('child-git-configuration');
  }

  private assertRemotePolicy(cwd: string, args: string[], remote: GitRemoteDescriptor | null): void {
    const command = args[0];
    const requiresRemote = command === 'clone' || command === 'fetch';
    if (requiresRemote !== (remote !== null)) this.fail('local-remote-policy', 'remote-metadata-mismatch');
    const externalSyntax = args.some((arg) => /^[a-z][a-z0-9+.-]*:\/\//i.test(arg) || /^[^/\\\s]+@[^:\s]+:/.test(arg));
    if (externalSyntax) this.fail('local-remote-policy', 'external-remote-syntax');
    if (remote?.kind === 'fixture-path') {
      const source = this.resolveCandidate(remote.value, cwd);
      if (!isPathWithinOrEqual(this.root, source) || args.at(-2) !== remote.value) {
        this.fail('local-remote-policy', 'remote-path-outside-fixture');
      }
    } else if (remote?.kind === 'registered-alias') {
      const aliases = this.localRemotes.get(this.resolveCandidate(cwd));
      if (!aliases?.has(remote.value) || args.at(-1) !== remote.value) {
        this.fail('local-remote-policy', 'unregistered-remote-alias');
      }
    }
    this.pass('local-remote-policy');
  }

  assertChild(
    cwd: string,
    args: string[],
    gitArgs: string[],
    env: NodeJS.ProcessEnv,
    options: GitRunOptions,
  ): void {
    const checkedCwd = this.resolveCandidate(cwd);
    if (!isPathWithinOrEqual(this.root, checkedCwd)) this.fail('child-cwd-boundary', 'child-cwd-outside-fixture');
    this.pass('child-cwd-boundary');
    this.assertPathOperands(checkedCwd, args, options.paths);
    this.assertEnvironment(env, options.readOnly === true);
    this.assertGitConfiguration(gitArgs);
    this.assertRemotePolicy(checkedCwd, args, options.remote);
  }

  assertComplete(totalGitCommands: number, assertions: AssertionCollector): void {
    const failed = Object.values(this.counts).reduce((total, count) => total + count.failed, 0);
    assertions.equal('runtime safety guards have zero failures', failed, 0);
    assertions.equal('every Git child cwd was boundary-checked', this.counts['child-cwd-boundary'].passed, totalGitCommands);
    assertions.equal('every Git child path contract was checked', this.counts['child-path-operands'].passed, totalGitCommands);
    assertions.equal('every Git child environment was checked', this.counts['child-environment'].passed, totalGitCommands);
    assertions.equal('every Git child configuration was checked', this.counts['child-git-configuration'].passed, totalGitCommands);
    assertions.equal('every Git child remote policy was checked', this.counts['local-remote-policy'].passed, totalGitCommands);
    assertions.equal('output boundary was checked exactly once', this.counts['output-boundary'].passed, 1);
    assertions.truthy('fixture paths were boundary-checked', this.counts['fixture-path-boundary'].passed > 0);
  }

  report(totalGitCommands: number): HarnessSafetyReport {
    const failed = Object.values(this.counts).reduce((total, count) => total + count.failed, 0);
    const childCwdChecksEqualGitCommands = this.counts['child-cwd-boundary'].passed === totalGitCommands;
    const childPathChecksEqualGitCommands = this.counts['child-path-operands'].passed === totalGitCommands;
    const childEnvironmentChecksEqualGitCommands = this.counts['child-environment'].passed === totalGitCommands;
    const childConfigurationChecksEqualGitCommands = this.counts['child-git-configuration'].passed === totalGitCommands;
    const remotePolicyChecksEqualGitCommands = this.counts['local-remote-policy'].passed === totalGitCommands;
    return {
      passed: failed === 0
        && childCwdChecksEqualGitCommands
        && childPathChecksEqualGitCommands
        && childEnvironmentChecksEqualGitCommands
        && childConfigurationChecksEqualGitCommands
        && remotePolicyChecksEqualGitCommands,
      fixtureBoundary: 'unique-os-temp-directory',
      outputBoundary: { mode: this.outputBoundary.mode, policy: this.outputBoundary.policy },
      guards: structuredClone(this.counts),
      evidence: {
        childCwdChecksEqualGitCommands,
        childPathChecksEqualGitCommands,
        childEnvironmentChecksEqualGitCommands,
        childConfigurationChecksEqualGitCommands,
        remotePolicyChecksEqualGitCommands,
        failedGuardCodes: [...this.failedGuardCodes],
      },
      directChildAccountingCaveat: 'Counts direct Git children spawned by this harness; Git helpers and external processes are excluded.',
    };
  }
}

class GitRunner {
  readonly root: string;
  private readonly hooksDirectory: string;
  private readonly globalConfig: string;
  private readonly metrics: MetricsCollector;
  private readonly guard: HarnessSafetyGuard;
  private readonly gitChildTimeoutMs: number;
  private readonly timeoutProbe: GitChildTimeoutProbe | null;
  private readonly activeCommands = new Set<Promise<GitCommandResult>>();
  private timeoutProbeUsed = false;

  constructor(
    root: string,
    hooksDirectory: string,
    globalConfig: string,
    metrics: MetricsCollector,
    guard: HarnessSafetyGuard,
    gitChildTimeoutMs: number,
    timeoutProbe: GitChildTimeoutProbe | undefined,
  ) {
    this.root = root;
    this.hooksDirectory = hooksDirectory;
    this.globalConfig = globalConfig;
    this.metrics = metrics;
    this.guard = guard;
    this.gitChildTimeoutMs = gitChildTimeoutMs;
    this.timeoutProbe = timeoutProbe ?? null;
  }

  private childSpawnSpec(
    gitArgs: string[],
    operationClass: string,
  ): { command: string; args: string[]; terminationGraceMs: number } {
    if (!this.timeoutProbeUsed && this.timeoutProbe?.operationClass === operationClass) {
      this.timeoutProbeUsed = true;
      const ignoreSigterm = this.timeoutProbe.ignoreSigterm === true && process.platform !== 'win32';
      const script = ignoreSigterm
        ? 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
        : 'setInterval(() => {}, 1000);';
      return {
        command: process.execPath,
        args: ['-e', script],
        terminationGraceMs: this.timeoutProbe.terminationGraceMs ?? GIT_CHILD_TERMINATION_GRACE_MS,
      };
    }
    return {
      command: 'git',
      args: gitArgs,
      terminationGraceMs: GIT_CHILD_TERMINATION_GRACE_MS,
    };
  }

  async run(
    cwd: string,
    args: string[],
    options: GitRunOptions,
  ): Promise<GitCommandResult> {
    const gitArgs = [
      '-c', `core.hooksPath=${this.hooksDirectory}`,
      '-c', 'gc.auto=0',
      '-c', 'maintenance.auto=false',
      ...args,
    ];
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of Object.keys(env)) {
      if (
        key.startsWith('GIT_')
        || key.startsWith('GCM_')
        || key.startsWith('SSH_ASKPASS')
        || key === 'SSH_AUTH_SOCK'
        || key === 'SSH_AGENT_PID'
      ) {
        delete env[key];
      }
    }
    Object.assign(env, {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: this.globalConfig,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_PAGER: 'cat',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    });
    if (options.readOnly) env.GIT_OPTIONAL_LOCKS = '0';

    this.guard.assertChild(cwd, args, gitArgs, env, options);
    this.metrics.gitCommandStarted(options.category, options.operationClass, options.scenario);
    this.metrics.gitChildStarted();
    try {
      let commandOutcomeRecorded = false;
      const childSpec = this.childSpawnSpec(gitArgs, options.operationClass);
      const execution = new Promise<GitCommandResult>((resolve, reject) => {
        const child = spawn(childSpec.command, childSpec.args, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let childError: Error | null = null;
        let timeoutTimer: NodeJS.Timeout | null = null;
        let graceTimer: NodeJS.Timeout | null = null;
        let spawned = false;
        let settled = false;
        let timedOut = false;
        let forced = false;

        const clearTimers = (): void => {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (graceTimer) clearTimeout(graceTimer);
          timeoutTimer = null;
          graceTimer = null;
        };

        const signalHarnessChild = (signal: NodeJS.Signals): boolean => {
          if (!child.pid) return false;
          if (process.platform !== 'win32') {
            try {
              process.kill(-child.pid, signal);
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
                childError = error instanceof Error ? error : new Error(String(error));
              }
            }
          }
          try {
            return child.kill(signal);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
              childError = error instanceof Error ? error : new Error(String(error));
            }
            return false;
          }
        };

        const forceTermination = (): void => {
          if (settled || forced) return;
          forced = true;
          this.metrics.gitChildForcedTerminations += 1;
          signalHarnessChild('SIGKILL');
        };

        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.once('spawn', () => {
          spawned = true;
          timeoutTimer = setTimeout(() => {
            if (settled) return;
            timedOut = true;
            this.metrics.gitChildTimeouts += 1;
            this.metrics.gitChildTerminationAttempts += 1;
            if (!signalHarnessChild('SIGTERM')) {
              forceTermination();
              return;
            }
            graceTimer = setTimeout(forceTermination, childSpec.terminationGraceMs);
          }, this.gitChildTimeoutMs);
        });
        child.once('error', (error) => {
          childError = error;
          if (!spawned && !settled) {
            settled = true;
            clearTimers();
            reject(error);
          }
        });
        child.once('close', (exitCode) => {
          if (settled) return;
          settled = true;
          clearTimers();
          if (timedOut) {
            this.metrics.gitChildReapedAfterTimeout += 1;
            if (!forced) this.metrics.gitChildGracefulTerminations += 1;
            reject(new GitChildTimeoutError(args, this.gitChildTimeoutMs));
            return;
          }
          if (childError) {
            reject(childError);
            return;
          }
          resolve({
            exitCode: exitCode ?? -1,
            stdout: Buffer.concat(stdout).toString('utf8'),
            stderr: Buffer.concat(stderr).toString('utf8'),
          });
        });
      });
      this.activeCommands.add(execution);
      try {
        const result = await execution.finally(() => this.activeCommands.delete(execution));
        if (result.exitCode === 0) this.metrics.gitCommandSuccesses += 1;
        else this.metrics.gitCommandFailures += 1;
        commandOutcomeRecorded = true;
        if (result.exitCode !== 0 && !options.allowFailure) throw new GitCommandError(args, result);
        return result;
      } catch (error) {
        if (!commandOutcomeRecorded) this.metrics.gitCommandFailures += 1;
        throw error;
      }
    } finally {
      this.metrics.gitChildFinished();
    }
  }

  async waitForIdle(
    timeoutMs = Math.max(
      30_000,
      this.gitChildTimeoutMs
        + Math.max(GIT_CHILD_TERMINATION_GRACE_MS, this.timeoutProbe?.terminationGraceMs ?? 0)
        + 5_000,
    ),
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (
      this.activeCommands.size > 0
      || this.metrics.activeGitChildren > 0
      || this.metrics.activeTopLevel > 0
      || this.metrics.activeSubmissions > 0
    ) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for harness-owned Git work to settle');
      await Promise.race([
        Promise.allSettled([...this.activeCommands]),
        sleep(25),
      ]);
      await sleep(5);
    }
    await flushMicrotasks();
  }
}

type RealFixture = {
  root: string;
  hooksDirectory: string;
  globalConfig: string;
  guard: HarnessSafetyGuard;
  runner: GitRunner;
  bareRemote: string | null;
  primaryWorktrees: string[];
  linkedWorktrees: string[];
  allWorktrees: string[];
};

const makeFixtureDirectory = async (fixture: RealFixture, directory: string): Promise<void> => {
  fixture.guard.assertFixturePath(directory, 'fixture-directory');
  await mkdir(directory, { recursive: true });
};

const writeFixtureFile = async (fixture: RealFixture, filePath: string, content: string): Promise<void> => {
  fixture.guard.assertFixturePath(filePath, 'fixture-file-write');
  await writeFile(filePath, content, 'utf8');
};

const removeFixturePath = async (
  fixture: RealFixture,
  targetPath: string,
  options: Parameters<typeof rm>[1],
): Promise<void> => {
  fixture.guard.assertFixturePath(targetPath, 'fixture-path-remove');
  await rm(targetPath, options);
};

const mapLimit = async <T, R>(values: T[], limit: number, mapper: (value: T, index: number) => Promise<R>): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return results;
};

const createHarnessRoot = async (
  metrics: MetricsCollector,
  outputBoundary: OutputBoundary,
  gitChildTimeoutMs: number,
  testHooks: GitExecutionRunOptions['testHooks'],
): Promise<RealFixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'openchamber-git-perf-'));
  try {
    const hooksDirectory = path.join(root, 'disabled-hooks');
    const globalConfig = path.join(root, 'global.gitconfig');
    const guard = new HarnessSafetyGuard(root, hooksDirectory, globalConfig, outputBoundary);
    guard.assertFixturePath(hooksDirectory, 'hooks-directory');
    guard.assertFixturePath(globalConfig, 'global-config');
    await mkdir(hooksDirectory, { recursive: true });
    await writeFile(globalConfig, '', 'utf8');
    return {
      root,
      hooksDirectory,
      globalConfig,
      guard,
      runner: new GitRunner(
        root,
        hooksDirectory,
        globalConfig,
        metrics,
        guard,
        gitChildTimeoutMs,
        testHooks?.gitChildTimeoutProbe,
      ),
      bareRemote: null,
      primaryWorktrees: [],
      linkedWorktrees: [],
      allWorktrees: [],
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
};

const fixtureSetupOptions = (paths: string[] = [], remote: GitRemoteDescriptor | null = null): GitRunOptions => ({
  category: 'fixture-setup',
  operationClass: 'setup',
  scenario: null,
  paths,
  remote,
});

const workloadOptions = (
  operationClass: string,
  scenario: ScenarioName,
  paths: string[] = [],
  remote: GitRemoteDescriptor | null = null,
  readOnly = false,
): GitRunOptions => ({
  category: 'workload',
  operationClass,
  scenario,
  paths,
  remote,
  ...(readOnly ? { readOnly: true } : {}),
});

const lockRecoveryOptions = (relativePath: string, allowFailure = false): GitRunOptions => ({
  category: 'lock-recovery',
  operationClass: 'lock-write',
  scenario: 'lock-recovery',
  paths: [relativePath],
  remote: null,
  ...(allowFailure ? { allowFailure: true } : {}),
});

const workloadCleanupOptions = (
  operationClass: string,
  scenario: ScenarioName,
  paths: string[],
): GitRunOptions => ({
  category: 'cleanup',
  operationClass,
  scenario,
  paths,
  remote: null,
});

const configureRepository = async (fixture: RealFixture, directory: string, bare = false): Promise<void> => {
  await fixture.runner.run(
    directory,
    ['config', 'core.hooksPath', fixture.hooksDirectory],
    fixtureSetupOptions([fixture.hooksDirectory]),
  );
  await fixture.runner.run(directory, ['config', 'gc.auto', '0'], fixtureSetupOptions());
  await fixture.runner.run(directory, ['config', 'maintenance.auto', 'false'], fixtureSetupOptions());
  if (!bare) {
    await fixture.runner.run(directory, ['config', 'user.name', 'OpenChamber Performance'], fixtureSetupOptions());
    await fixture.runner.run(directory, ['config', 'user.email', 'perf@openchamber.invalid'], fixtureSetupOptions());
  }
};

const createRealTopology = async (
  fixture: RealFixture,
  commonDirectories: number,
  linkedWorktrees: number,
): Promise<void> => {
  const seedRepository = path.join(fixture.root, 'seed');
  const bareRemote = path.join(fixture.root, 'remote.git');
  await makeFixtureDirectory(fixture, seedRepository);
  await fixture.runner.run(seedRepository, ['init', '--quiet'], fixtureSetupOptions());
  await fixture.runner.run(seedRepository, ['symbolic-ref', 'HEAD', 'refs/heads/main'], fixtureSetupOptions());
  await configureRepository(fixture, seedRepository);
  await writeFixtureFile(fixture, path.join(seedRepository, 'README.md'), '# OpenChamber Git performance fixture\n');
  await fixture.runner.run(seedRepository, ['add', '--', 'README.md'], fixtureSetupOptions(['README.md']));
  await fixture.runner.run(seedRepository, ['commit', '--quiet', '-m', 'Initial fixture'], fixtureSetupOptions());
  await fixture.runner.run(
    fixture.root,
    ['clone', '--quiet', '--bare', seedRepository, bareRemote],
    fixtureSetupOptions([bareRemote], { kind: 'fixture-path', value: seedRepository }),
  );
  await configureRepository(fixture, bareRemote, true);
  fixture.bareRemote = bareRemote;

  const repositoriesRoot = path.join(fixture.root, 'repositories');
  await makeFixtureDirectory(fixture, repositoriesRoot);
  fixture.primaryWorktrees = await mapLimit(
    Array.from({ length: commonDirectories }, (_, index) => index),
    8,
    async (index) => {
      const destination = path.join(repositoriesRoot, `repository-${index}`);
      await fixture.runner.run(
        fixture.root,
        ['clone', '--quiet', bareRemote, destination],
        fixtureSetupOptions([destination], { kind: 'fixture-path', value: bareRemote }),
      );
      fixture.guard.registerLocalRemote(destination, 'origin', bareRemote);
      await configureRepository(fixture, destination);
      return destination;
    },
  );

  const linkedRoot = path.join(fixture.root, 'linked-worktrees');
  await makeFixtureDirectory(fixture, linkedRoot);
  fixture.linkedWorktrees = await mapLimit(
    Array.from({ length: linkedWorktrees }, (_, index) => index),
    8,
    async (index) => {
      const owner = fixture.primaryWorktrees[index % fixture.primaryWorktrees.length]!;
      const destination = path.join(linkedRoot, `worktree-${index}`);
      await fixture.runner.run(
        owner,
        ['worktree', 'add', '--quiet', '--detach', destination, 'HEAD'],
        fixtureSetupOptions([destination]),
      );
      fixture.guard.registerLocalRemote(destination, 'origin', bareRemote);
      return destination;
    },
  );
  fixture.allWorktrees = [...fixture.primaryWorktrees, ...fixture.linkedWorktrees];
};

const loadWebModules = async (): Promise<{ coordinator: CoordinatorModule; resolver: ResolverModule }> => {
  const coordinator = await import('../../packages/web/server/lib/git/execution-coordinator.js') as unknown as CoordinatorModule;
  const resolver = await import('../../packages/web/server/lib/git/context-resolver.js') as unknown as ResolverModule;
  return { coordinator, resolver };
};

const loadVsCodeModules = async (): Promise<{ coordinator: CoordinatorModule; resolver: ResolverModule }> => {
  const coordinator = await import('../../packages/vscode/src/git-execution-coordinator.ts') as unknown as CoordinatorModule;
  const resolver = await import('../../packages/vscode/src/git-context-resolver.ts') as unknown as ResolverModule;
  return { coordinator, resolver };
};

const resolveFixtureContexts = async (
  fixture: RealFixture,
  resolverModule: ResolverModule,
): Promise<{ resolver: ResolverLike; contexts: ExecutionContext[] }> => {
  const resolver = resolverModule.createGitContextResolver({
    runGit: async (cwd, args) => fixture.runner.run(cwd, args, {
      category: 'discovery',
      operationClass: 'discovery',
      scenario: null,
      paths: [],
      remote: null,
      readOnly: true,
      allowFailure: true,
    }).then((result) => ({ success: result.exitCode === 0, ...result })),
  });
  const resolved = await Promise.all(fixture.allWorktrees.map((directory) => resolver.resolve(directory)));
  const contexts = resolved.filter((entry): entry is ExecutionContext => entry.isRepository === true);
  return { resolver, contexts };
};

const runOperation = async <T>(
  coordinator: CoordinatorLike,
  metrics: MetricsCollector,
  scenarioName: ScenarioName,
  operationClass: string,
  options: {
    context: ExecutionContext;
    kind: OperationKind;
    targetWorktree?: boolean;
    network?: boolean;
    label?: string;
  },
  task: () => Promise<T> | T,
): Promise<T> => {
  metrics.submit(scenarioName, operationClass);
  const submittedAt = performance.now();
  let queueMs = 0;
  let serviceMs = 0;
  let started = false;
  try {
    const promise = coordinator.run(options, async () => {
      started = true;
      const serviceStartedAt = performance.now();
      queueMs = serviceStartedAt - submittedAt;
      metrics.startUnderlying(scenarioName, operationClass, options.context, options.kind, options.network === true);
      metrics.sampleCoordinator(coordinator.getStats());
      try {
        return await task();
      } finally {
        serviceMs = performance.now() - serviceStartedAt;
        metrics.finishUnderlying(options.context, options.kind, options.network === true);
        metrics.sampleCoordinator(coordinator.getStats());
      }
    });
    metrics.sampleCoordinator(coordinator.getStats());
    try {
      return await promise;
    } finally {
      if (started) {
        metrics.recordUnderlyingTiming(operationClass, {
          queueMs,
          serviceMs,
          totalMs: performance.now() - submittedAt,
        });
      }
      metrics.sampleCoordinator(coordinator.getStats());
    }
  } finally {
    metrics.recordWaiterObservedTotal(operationClass, performance.now() - submittedAt);
    metrics.submissionFinished();
  }
};

const runStatus = async <T>(
  coordinator: CoordinatorLike,
  metrics: MetricsCollector,
  scenarioName: ScenarioName,
  operationClass: string,
  context: ExecutionContext,
  task: (shape: 'full' | 'light') => Promise<T> | T,
  shape: 'full' | 'light' = 'full',
): Promise<T> => {
  metrics.submit(scenarioName, operationClass, true);
  const submittedAt = performance.now();
  let queueMs = 0;
  let serviceMs = 0;
  let started = false;
  try {
    const promise = coordinator.runStatus({ context, shape, label: operationClass }, async (sourceShape) => {
      started = true;
      const serviceStartedAt = performance.now();
      queueMs = serviceStartedAt - submittedAt;
      metrics.startUnderlying(scenarioName, operationClass, context, 'read', false);
      metrics.sampleCoordinator(coordinator.getStats());
      try {
        return await task(sourceShape);
      } finally {
        serviceMs = performance.now() - serviceStartedAt;
        metrics.finishUnderlying(context, 'read', false);
        metrics.sampleCoordinator(coordinator.getStats());
      }
    });
    metrics.sampleCoordinator(coordinator.getStats());
    try {
      return await promise;
    } finally {
      if (started) {
        metrics.recordUnderlyingTiming(operationClass, {
          queueMs,
          serviceMs,
          totalMs: performance.now() - submittedAt,
        });
      }
      metrics.sampleCoordinator(coordinator.getStats());
    }
  } finally {
    metrics.recordWaiterObservedTotal(operationClass, performance.now() - submittedAt);
    metrics.submissionFinished();
  }
};

const generationTotal = (coordinator: CoordinatorLike, contexts: ExecutionContext[]): number => {
  const byCommon = new Map<string, ExecutionContext>();
  const byWorktree = new Map<string, ExecutionContext>();
  for (const context of contexts) {
    byCommon.set(context.commonId, context);
    byWorktree.set(context.worktreeId, context);
  }
  const commonTotal = [...byCommon.values()]
    .reduce((total, context) => total + coordinator.getGeneration(context).common, 0);
  const worktreeTotal = [...byWorktree.values()]
    .reduce((total, context) => total + coordinator.getGeneration(context).worktree, 0);
  return commonTotal + worktreeTotal;
};

const assertDrainedAndEvict = (
  coordinator: CoordinatorLike,
  resolver: ResolverLike | null,
  assertions: AssertionCollector,
): {
  retainedBeforeEviction: { contexts: number; worktrees: number };
  finalCoordinator: CoordinatorStats;
  finalResolver: ResolverStats | null;
} => {
  const retained = coordinator.getStats();
  assertions.equal('coordinator active drained', retained.active, 0);
  assertions.equal('coordinator pending drained', retained.pending, 0);
  assertions.equal('coordinator network drained', retained.activeNetwork, 0);
  assertions.equal('status in-flight drained', retained.statusInFlight, 0);
  assertions.equal('clone queue drained', retained.clonePending, 0);
  assertions.equal('clone destinations drained', retained.cloneDestinations, 0);
  assertions.atMost('retained contexts within bound', retained.contexts, retained.limits.maxContexts);
  assertions.atMost('retained worktrees within bound', retained.worktrees, retained.limits.maxWorktrees);
  assertions.atMost('status map within bound', retained.statusInFlight, retained.limits.maxStatusInFlight);
  if (resolver) {
    const resolverStats = resolver.getStats();
    assertions.equal('resolver aliases drained', resolverStats.inFlightAliases, 0);
    assertions.equal('resolver contexts drained', resolverStats.inFlightContexts, 0);
    assertions.equal('resolver active discovery drained', resolverStats.discovery.active, 0);
    assertions.equal('resolver pending discovery drained', resolverStats.discovery.pending, 0);
  }
  coordinator.pruneIdle({ force: true });
  const finalCoordinator = coordinator.getStats();
  assertions.equal('eligible contexts evicted', finalCoordinator.contexts, 0);
  assertions.equal('eligible worktrees evicted', finalCoordinator.worktrees, 0);
  return {
    retainedBeforeEviction: { contexts: retained.contexts, worktrees: retained.worktrees },
    finalCoordinator,
    finalResolver: resolver?.getStats() ?? null,
  };
};

const runExternalLockScenario = async (
  coordinator: CoordinatorLike,
  metrics: MetricsCollector,
  fixture: RealFixture,
  context: ExecutionContext,
  directory: string,
  assertions: AssertionCollector,
): Promise<void> => {
  const relativePath = 'lock-recovery.txt';
  const lockPath = path.join(context.gitDir ?? path.join(directory, '.git'), 'index.lock');
  await writeFixtureFile(fixture, path.join(directory, relativePath), 'external lock recovery\n');
  await writeFixtureFile(fixture, lockPath, 'external owner\n');
  try {
    try {
      await runOperation(
        coordinator,
        metrics,
        'lock-recovery',
        'lock-write',
        { context, kind: 'worktree-write', label: 'external index lock failure' },
        async () => {
          const result = await fixture.runner.run(
            directory,
            ['add', '--', relativePath],
            lockRecoveryOptions(relativePath, true),
          );
          if (result.exitCode === 0) {
            throw new Error('Git unexpectedly ignored the external index lock');
          }
          metrics.expectedErrors += 1;
          metrics.lockFailures += 1;
          throw new ExpectedLockFailure(result.stderr || result.stdout);
        },
      );
      assertions.truthy('external lock operation failed', false);
    } catch (error) {
      assertions.truthy('external lock failure is authoritative', error instanceof ExpectedLockFailure);
    }
  } finally {
    await removeFixturePath(fixture, lockPath, { force: true });
  }

  await runOperation(
    coordinator,
    metrics,
    'lock-recovery',
    'lock-write',
    { context, kind: 'worktree-write', label: 'external index lock retry' },
    async () => fixture.runner.run(directory, ['add', '--', relativePath], lockRecoveryOptions(relativePath)),
  );
  metrics.lockRetries += 1;
  assertions.equal('external lock failure count', metrics.lockFailures, 1);
  assertions.equal('external lock retry count', metrics.lockRetries, 1);
};

type ProfileOutcome = {
  coordinator: CoordinatorLike | null;
  resolver: ResolverLike | null;
  contexts: ExecutionContext[];
  generationTotal: number;
  retainedBeforeEviction: { contexts: number; worktrees: number };
  finalCoordinator: CoordinatorStats | null;
  finalResolver: ResolverStats | null;
  details: Record<string, unknown>;
};

const runPrReal = async (
  fixture: RealFixture,
  modules: { coordinator: CoordinatorModule; resolver: ResolverModule },
  metrics: MetricsCollector,
  assertions: AssertionCollector,
  seed: number,
): Promise<ProfileOutcome> => {
  await createRealTopology(fixture, 1, 1);
  const mappingBefore = metrics.workSnapshot();
  const sessions = buildSessionRecords(PROFILE_DEFAULTS.prReal.sessionRecords, fixture.allWorktrees);
  const mappedWorktrees = new Set(sessions.map((session) => session.directory)).size;
  metrics.recordEntityMapping(true, sessions.length, mappedWorktrees, mappingBefore);
  metrics.declareScenario('startup', PROFILE_DEFAULTS.prReal.worktreeIdentities);
  metrics.declareScenario('fairness', 3);
  metrics.declareScenario('local-fetch', 1);
  metrics.declareScenario('lock-recovery', 2);
  const { resolver, contexts } = await resolveFixtureContexts(fixture, modules.resolver);
  const coordinator = modules.coordinator.createGitExecutionCoordinator();

  assertions.equal('PR entity mapping session count', metrics.entityMapping.sessionEntities, 30);
  assertions.equal('PR entity mapping worktree count', metrics.entityMapping.worktreeIdentities, 2);
  assertions.equal('PR entity mapping coordinator submissions', metrics.entityMapping.coordinatorApiSubmissions, 0);
  assertions.equal('PR entity mapping scheduled operations', metrics.entityMapping.underlyingScheduledOperations, 0);
  assertions.equal('PR entity mapping Git commands', metrics.entityMapping.gitCommands, 0);
  assertions.equal('PR common directory count', new Set(contexts.map((context) => context.commonId)).size, 1);
  assertions.equal('PR worktree identity count', new Set(contexts.map((context) => context.worktreeId)).size, 2);
  assertions.truthy('linked worktree shares common identity', contexts[0]?.commonId === contexts[1]?.commonId);
  assertions.truthy('linked worktree has distinct identity', contexts[0]?.worktreeId !== contexts[1]?.worktreeId);

  await Promise.all(contexts.map((context, index) => runStatus(
    coordinator,
    metrics,
    'startup',
    'startup-status',
    context,
    async () => fixture.runner.run(
      fixture.allWorktrees[index]!,
      ['status', '--porcelain=v1'],
      workloadOptions('startup-status', 'startup', [], null, true),
    ).then((result) => result.stdout),
  )));

  const fairnessEvents: string[] = [];
  const readStarted = deferred<void>();
  const releaseRead = deferred<void>();
  const fairnessFile = 'fairness.txt';
  await writeFixtureFile(fixture, path.join(fixture.allWorktrees[0]!, fairnessFile), `seed-${seed}\n`);
  const firstRead = runOperation(
    coordinator,
    metrics,
    'fairness',
    'fairness-read',
    { context: contexts[0]!, kind: 'read', label: 'fairness first read' },
    async () => {
      fairnessEvents.push('read:start');
      readStarted.resolve();
      await releaseRead.promise;
      const result = await fixture.runner.run(
        fixture.allWorktrees[0]!,
        ['status', '--porcelain=v1'],
        workloadOptions('fairness-read', 'fairness', [], null, true),
      );
      fairnessEvents.push('read:end');
      return result.stdout;
    },
  );
  await readStarted.promise;
  const writer = runOperation(
    coordinator,
    metrics,
    'fairness',
    'worktree-write',
    { context: contexts[0]!, kind: 'worktree-write', label: 'fairness writer' },
    async () => {
      fairnessEvents.push('write');
      return fixture.runner.run(
        fixture.allWorktrees[0]!,
        ['add', '--', fairnessFile],
        workloadOptions('worktree-write', 'fairness', [fairnessFile]),
      );
    },
  );
  const laterRead = runOperation(
    coordinator,
    metrics,
    'fairness',
    'diff-read',
    { context: contexts[0]!, kind: 'read', label: 'fairness later read' },
    async () => {
      fairnessEvents.push('late-read');
      return fixture.runner.run(
        fixture.allWorktrees[0]!,
        ['diff', '--stat'],
        workloadOptions('diff-read', 'fairness', [], null, true),
      );
    },
  );
  await flushMicrotasks();
  assertions.deepEqual('writer and later read remain queued behind first read', fairnessEvents, ['read:start']);
  releaseRead.resolve();
  await Promise.all([firstRead, writer, laterRead]);
  assertions.deepEqual('queued writer runs before later conflicting read', fairnessEvents, [
    'read:start',
    'read:end',
    'write',
    'late-read',
  ]);

  await runOperation(
    coordinator,
    metrics,
    'local-fetch',
    'fetch',
    { context: contexts[0]!, kind: 'common-write', network: true, label: 'local bare fetch' },
    async () => fixture.runner.run(
      fixture.allWorktrees[0]!,
      ['fetch', '--quiet', 'origin'],
      workloadOptions('fetch', 'local-fetch', [], { kind: 'registered-alias', value: 'origin' }),
    ),
  );
  await runExternalLockScenario(
    coordinator,
    metrics,
    fixture,
    contexts[1]!,
    fixture.allWorktrees[1]!,
    assertions,
  );

  const parity = await runCoordinatorParityAssertions();
  assertions.truthy('web and VS Code deterministic coordinator parity', parity.equal);
  const generation = generationTotal(coordinator, contexts);
  assertions.truthy('PR mutations move generations', generation > 0);
  assertions.atMost('global active cap respected', metrics.peakTopLevel, coordinator.getStats().limits.globalConcurrency);
  assertions.atMost('per-context read cap respected', metrics.peakPerContextReads, coordinator.getStats().limits.readsPerCommonContext);
  assertions.atMost('global network cap respected', metrics.peakGlobalNetwork, coordinator.getStats().limits.globalNetworkConcurrency);
  assertions.atMost('per-context network cap respected', metrics.peakPerContextNetwork, coordinator.getStats().limits.networkPerCommonContext);
  assertions.equal('PR unexpected errors', metrics.unexpectedErrors, 0);
  assertions.equal('PR overload count', metrics.overloads, 0);
  assertions.equal('PR expected error count', metrics.expectedErrors, 1);
  assertions.equal('PR coordinator submissions exact', metrics.coordinatorSubmissions, 8);
  assertions.equal('PR underlying operations exact', metrics.underlyingOperations, 8);
  assertions.equal('PR status waiters exact', metrics.statusWaiters, 2);
  assertions.equal('PR status operations exact', metrics.statusUnderlying, 2);
  assertions.equal('PR startup all-waiter latency count', metrics.waiterLatencyReport()['startup-status']?.count, 2);
  assertions.equal('PR startup underlying latency count', metrics.underlyingLatencyReport()['startup-status']?.totalMs.count, 2);
  assertions.equal('PR startup Git commands exact', metrics.gitCommandsByClass['startup-status'] ?? 0, 2);
  assertions.equal('PR fairness read Git commands exact', metrics.gitCommandsByClass['fairness-read'] ?? 0, 1);
  assertions.equal('PR diff Git commands exact', metrics.gitCommandsByClass['diff-read'] ?? 0, 1);
  assertions.equal('PR worktree write Git commands exact', metrics.gitCommandsByClass['worktree-write'] ?? 0, 1);
  assertions.equal('PR fetch Git commands exact', metrics.gitCommandsByClass.fetch ?? 0, 1);
  assertions.equal('PR lock Git commands exact', metrics.gitCommandsByClass['lock-write'] ?? 0, 2);
  assertions.equal('PR discovery Git commands exact', metrics.gitCommandsByClass.discovery ?? 0, 2);
  const lifecycle = assertDrainedAndEvict(coordinator, resolver, assertions);
  assertions.equal('PR retained common contexts exact', lifecycle.retainedBeforeEviction.contexts, 1);
  assertions.equal('PR retained worktrees exact', lifecycle.retainedBeforeEviction.worktrees, 2);
  assertions.equal('PR generation movement exact', generation, 8);
  return {
    coordinator,
    resolver,
    contexts,
    generationTotal: generation,
    ...lifecycle,
    details: {
      fairnessEvents,
      parity,
      targetUnderThirtySecondsIsAdvisory: true,
    },
  };
};

const buildSessionRecords = (count: number, worktrees: string[]): Array<{ id: string; directory: string }> => (
  Array.from({ length: count }, (_, index) => ({
    id: `session-${index}`,
    directory: worktrees[index % worktrees.length]!,
  }))
);

const runTargetReal = async (
  fixture: RealFixture,
  modules: { coordinator: CoordinatorModule; resolver: ResolverModule },
  metrics: MetricsCollector,
  assertions: AssertionCollector,
  seed: number,
  config: ProfileConfig,
): Promise<ProfileOutcome> => {
  await createRealTopology(fixture, config.commonDirectories, config.linkedWorktrees);
  const mappingBefore = metrics.workSnapshot();
  const sessions = buildSessionRecords(config.sessionRecords, fixture.allWorktrees);
  const uniqueSessionWorktrees = [...new Set(sessions.map((session) => session.directory))];
  metrics.recordEntityMapping(true, sessions.length, uniqueSessionWorktrees.length, mappingBefore);
  metrics.declareScenario('startup', config.startupCallers);
  metrics.declareScenario('pathological-fanout', config.fanoutCallers);
  metrics.declareScenario('mixed-workload', config.mutations + config.fetches);
  metrics.declareScenario('lock-recovery', 2);
  assertions.equal('session records exact', sessions.length, config.sessionRecords);
  assertions.equal('sessions map to exact unique worktrees', uniqueSessionWorktrees.length, config.worktreeIdentities);
  assertions.equal('entity mapping coordinator submissions are zero', metrics.entityMapping.coordinatorApiSubmissions, 0);
  assertions.equal('entity mapping scheduled operations are zero', metrics.entityMapping.underlyingScheduledOperations, 0);
  assertions.equal('entity mapping Git commands are zero', metrics.entityMapping.gitCommands, 0);

  const { resolver, contexts } = await resolveFixtureContexts(fixture, modules.resolver);
  const coordinator = modules.coordinator.createGitExecutionCoordinator();
  assertions.equal('resolved common directory count', new Set(contexts.map((context) => context.commonId)).size, config.commonDirectories);
  assertions.equal('resolved worktree identity count', new Set(contexts.map((context) => context.worktreeId)).size, config.worktreeIdentities);
  assertions.equal('entity mapping discovery submissions are per worktree', metrics.gitCommandsByClass.discovery ?? 0, config.worktreeIdentities);

  await Promise.all(contexts.map((context, index) => runStatus(
    coordinator,
    metrics,
    'startup',
    'startup-status',
    context,
    async () => fixture.runner.run(
      fixture.allWorktrees[index]!,
      ['status', '--porcelain=v1'],
      workloadOptions('startup-status', 'startup', [], null, true),
    ).then((result) => result.stdout),
  )));
  assertions.equal('startup status callers exact', metrics.submissionsByClass['startup-status'] ?? 0, config.startupCallers);
  assertions.equal('startup status operations exact', metrics.underlyingByClass['startup-status'] ?? 0, config.worktreeIdentities);

  const random = new SeededRandom(seed);
  const fanoutIndices = [
    ...Array.from({ length: contexts.length }, (_, index) => index),
    ...Array.from({ length: config.fanoutCallers - contexts.length }, () => random.integer(contexts.length)),
  ];
  const fanoutResults = await Promise.all(fanoutIndices.map((contextIndex) => runStatus(
    coordinator,
    metrics,
    'pathological-fanout',
    'pathological-fanout-status',
    contexts[contextIndex]!,
    async () => fixture.runner.run(
      fixture.allWorktrees[contextIndex]!,
      ['status', '--porcelain=v1'],
      workloadOptions('pathological-fanout-status', 'pathological-fanout', [], null, true),
    ).then((result) => result.stdout),
  )));
  assertions.equal('pathological fan-out caller count exact', fanoutResults.length, config.fanoutCallers);
  assertions.equal(
    'pathological fan-out coalesces to one task per worktree',
    metrics.underlyingByClass['pathological-fanout-status'] ?? 0,
    config.worktreeIdentities,
  );
  assertions.equal(
    'pathological fan-out Git commands exact',
    metrics.gitCommandsByClass['pathological-fanout-status'] ?? 0,
    config.worktreeIdentities,
  );
  assertions.equal(
    'pathological fan-out all-waiter latency count exact',
    metrics.waiterLatencyReport()['pathological-fanout-status']?.count,
    config.fanoutCallers,
  );
  assertions.equal(
    'pathological fan-out underlying latency count exact',
    metrics.underlyingLatencyReport()['pathological-fanout-status']?.totalMs.count,
    config.worktreeIdentities,
  );

  type MixedSpec = { type: 'mutation'; index: number } | { type: 'fetch'; index: number };
  const mixed = random.shuffle<MixedSpec>([
    ...Array.from({ length: config.mutations }, (_, index): MixedSpec => ({ type: 'mutation', index })),
    ...Array.from({ length: config.fetches }, (_, index): MixedSpec => ({ type: 'fetch', index })),
  ]);
  const commonRepresentatives = [...new Map(contexts.map((context) => [context.commonId, context])).values()];
  await Promise.all(mixed.map((spec) => {
    if (spec.type === 'fetch') {
      const context = commonRepresentatives[spec.index % commonRepresentatives.length]!;
      const directory = context.topLevel ?? fixture.primaryWorktrees[spec.index % fixture.primaryWorktrees.length]!;
      return runOperation(
        coordinator,
        metrics,
        'mixed-workload',
        'mixed-fetch',
        { context, kind: 'common-write', network: true, label: `mixed fetch ${spec.index}` },
        async () => fixture.runner.run(
          directory,
          ['fetch', '--quiet', 'origin'],
          workloadOptions('mixed-fetch', 'mixed-workload', [], { kind: 'registered-alias', value: 'origin' }),
        ),
      );
    }
    const contextIndex = spec.index % contexts.length;
    const context = contexts[contextIndex]!;
    const directory = fixture.allWorktrees[contextIndex]!;
    const relativePath = `mutation-${spec.index}.txt`;
    return runOperation(
      coordinator,
      metrics,
      'mixed-workload',
      'mixed-mutation',
      { context, kind: 'worktree-write', label: `mixed mutation ${spec.index}` },
      async () => {
        await writeFixtureFile(fixture, path.join(directory, relativePath), `mutation ${spec.index}\n`);
        return fixture.runner.run(
          directory,
          ['add', '--', relativePath],
          workloadOptions('mixed-mutation', 'mixed-workload', [relativePath]),
        );
      },
    );
  }));
  assertions.equal('mixed mutations exact', metrics.underlyingByClass['mixed-mutation'] ?? 0, config.mutations);
  assertions.equal('mixed mutation Git commands exact', metrics.gitCommandsByClass['mixed-mutation'] ?? 0, config.mutations);
  assertions.equal('mixed fetches exact', metrics.underlyingByClass['mixed-fetch'] ?? 0, config.fetches);
  assertions.equal('mixed fetch Git commands exact', metrics.gitCommandsByClass['mixed-fetch'] ?? 0, config.fetches);

  await runExternalLockScenario(coordinator, metrics, fixture, contexts[0]!, fixture.allWorktrees[0]!, assertions);
  const generation = generationTotal(coordinator, contexts);
  assertions.equal('target generation movement exact', generation, 2 * (config.mutations + config.fetches + 2));
  assertions.atMost('target global active cap respected', metrics.peakTopLevel, coordinator.getStats().limits.globalConcurrency);
  assertions.atMost('target per-context read cap respected', metrics.peakPerContextReads, coordinator.getStats().limits.readsPerCommonContext);
  assertions.atMost('target global network cap respected', metrics.peakGlobalNetwork, coordinator.getStats().limits.globalNetworkConcurrency);
  assertions.atMost('target per-context network cap respected', metrics.peakPerContextNetwork, coordinator.getStats().limits.networkPerCommonContext);
  assertions.equal('target unexpected errors', metrics.unexpectedErrors, 0);
  assertions.equal('target overload count', metrics.overloads, 0);
  const scenarioCounters = metrics.scenarioReport();
  assertions.equal('startup scenario logical callers exact', scenarioCounters.startup?.logicalCallers, config.startupCallers);
  assertions.equal('startup scenario API submissions exact', scenarioCounters.startup?.coordinatorApiSubmissions, config.startupCallers);
  assertions.equal('pathological scenario logical callers exact', scenarioCounters['pathological-fanout']?.logicalCallers, config.fanoutCallers);
  assertions.equal('pathological scenario API submissions exact', scenarioCounters['pathological-fanout']?.coordinatorApiSubmissions, config.fanoutCallers);
  const lifecycle = assertDrainedAndEvict(coordinator, resolver, assertions);
  assertions.equal('retained target common contexts exact', lifecycle.retainedBeforeEviction.contexts, config.commonDirectories);
  assertions.equal('retained target worktrees exact', lifecycle.retainedBeforeEviction.worktrees, config.worktreeIdentities);

  return {
    coordinator,
    resolver,
    contexts,
    generationTotal: generation,
    ...lifecycle,
    details: {
      development: config.development,
      entityCardinality: {
        sessionRecords: sessions.length,
        uniqueWorktrees: uniqueSessionWorktrees.length,
        mappingCoordinatorSubmissions: metrics.entityMapping.coordinatorApiSubmissions,
        mappingUnderlyingOperations: metrics.entityMapping.underlyingScheduledOperations,
        mappingGitCommands: metrics.entityMapping.gitCommands,
        discoveryGitCommands: metrics.gitCommandsByClass.discovery ?? 0,
        startupSubmissions: metrics.submissionsByClass['startup-status'] ?? 0,
      },
      startupStatusBurst: {
        callers: config.startupCallers,
        underlying: metrics.underlyingByClass['startup-status'] ?? 0,
      },
      pathologicalFanout: {
        label: 'pathological fan-out correctness guard, not representative concurrency',
        callers: config.fanoutCallers,
        underlying: metrics.underlyingByClass['pathological-fanout-status'] ?? 0,
      },
      mixed: { mutations: config.mutations, fetches: config.fetches },
    },
  };
};

type SoakOperationType = 'topology' | 'status' | 'diff' | 'mutation' | 'fetch';

type SoakSpec = {
  index: number;
  contextIndex: number;
  type: SoakOperationType;
};

type SoakOperationEvent = {
  index: number;
  contextIndex: number;
  type: Exclude<SoakOperationType, 'status'>;
};

type SoakStatusGroup = {
  index: number;
  contextIndex: number;
  type: 'status-group';
  ordinal: number;
  callerIndices: readonly number[];
  wave: number;
  idleSegment: number;
  plannedGeneration: Readonly<{ common: number; worktree: number }>;
};

type SoakPlan = {
  events: readonly (SoakOperationEvent | SoakStatusGroup)[];
  intervalMs: number;
  idleEvery: number;
  topologyEvery: number;
  statusWaveMs: number;
  callerCounts: Readonly<Record<SoakOperationType, number>>;
  statusGroupSizeCounts: Readonly<Record<string, number>>;
  expected: Readonly<{
    logicalCallers: number;
    coordinatorApiSubmissions: number;
    underlyingScheduledOperations: number;
    statusGroups: number;
    generationMovement: number;
  }>;
  gitCommandExpectation: GitCommandExpectation;
};

export type GitExecutionSoakPlanSummary = Readonly<{
  generatedBeforeExecution: true;
  statusGrouping: string;
  statusWaveMs: number;
  topologyEvery: number;
  idleEvery: number;
  eventCount: number;
  callerCounts: Readonly<{
    topology: number;
    status: number;
    diff: number;
    mutation: number;
    fetch: number;
  }>;
  statusGroups: number;
  statusGroupSizeCounts: Readonly<Record<string, number>>;
  expected: Readonly<{
    logicalCallers: number;
    coordinatorApiSubmissions: number;
    underlyingScheduledOperations: number;
    gitCommands: number;
    generationMovement: number;
  }>;
  gitCommandsByCategory: Readonly<Record<GitCommandCategory, number>>;
  gitCommandsByClass: Readonly<Record<string, number>>;
  gitCommandEquation: string;
}>;

const SOAK_STATUS_WAVE_MS = 1_000;

const soakCommonIndex = (contextIndex: number, config: ProfileConfig): number => {
  if (contextIndex < config.commonDirectories) return contextIndex;
  return (contextIndex - config.commonDirectories) % config.commonDirectories;
};

const buildSoakPlan = (seed: number, config: ProfileConfig): SoakPlan => {
  if (config.commonDirectories <= 0 || config.worktreeIdentities <= 0 || config.rate <= 0) {
    throw new Error('Soak planning requires positive common-directory, worktree, and rate values');
  }
  const random = new SeededRandom(seed);
  const operationCount = Math.max(1, Math.floor((config.durationMs / 1_000) * config.rate));
  const topologyEvery = Math.max(1, Math.floor(config.rate * 5));
  const idleEvery = Math.max(1, Math.floor(config.rate * 10));
  const intervalMs = 1_000 / config.rate;
  const callers = Array.from({ length: operationCount }, (_, index): SoakSpec => {
    const contextIndex = random.integer(config.worktreeIdentities);
    if (index > 0 && index % topologyEvery === 0) return { index, contextIndex, type: 'topology' };
    const choice = random.integer(100);
    if (choice < 55) return { index, contextIndex, type: 'status' };
    if (choice < 75) return { index, contextIndex, type: 'diff' };
    if (choice < 94) return { index, contextIndex, type: 'mutation' };
    return { index, contextIndex, type: 'fetch' };
  });

  const callerCounts: Record<SoakOperationType, number> = {
    topology: 0,
    status: 0,
    diff: 0,
    mutation: 0,
    fetch: 0,
  };
  const commonGenerations = Array.from({ length: config.commonDirectories }, () => 0);
  const worktreeGenerations = Array.from({ length: config.worktreeIdentities }, () => 0);
  const operationEvents: SoakOperationEvent[] = [];
  const mutableStatusGroups = new Map<string, Omit<SoakStatusGroup, 'ordinal'>>();
  let idleSegment = 0;

  for (const spec of callers) {
    callerCounts[spec.type] += 1;
    const commonIndex = soakCommonIndex(spec.contextIndex, config);
    if (spec.type === 'status') {
      const wave = Math.floor((spec.index * intervalMs) / SOAK_STATUS_WAVE_MS);
      const plannedGeneration = {
        common: commonGenerations[commonIndex]!,
        worktree: worktreeGenerations[spec.contextIndex]!,
      };
      const key = JSON.stringify([
        idleSegment,
        wave,
        commonIndex,
        spec.contextIndex,
        plannedGeneration.common,
        plannedGeneration.worktree,
      ]);
      const existing = mutableStatusGroups.get(key);
      if (existing) {
        existing.index = spec.index;
        (existing.callerIndices as number[]).push(spec.index);
      } else {
        mutableStatusGroups.set(key, {
          index: spec.index,
          contextIndex: spec.contextIndex,
          type: 'status-group',
          callerIndices: [spec.index],
          wave,
          idleSegment,
          plannedGeneration,
        });
      }
    } else {
      operationEvents.push({ ...spec, type: spec.type });
      if (spec.type === 'mutation') {
        worktreeGenerations[spec.contextIndex] += 2;
      } else if (spec.type === 'fetch' || spec.type === 'topology') {
        commonGenerations[commonIndex] += 2;
      }
    }

    if (spec.index > 0 && spec.index % idleEvery === 0) {
      commonGenerations.fill(0);
      worktreeGenerations.fill(0);
      idleSegment += 1;
    }
  }

  const statusGroups = [...mutableStatusGroups.values()]
    .sort((left, right) => left.index - right.index || left.contextIndex - right.contextIndex)
    .map((group, ordinal): SoakStatusGroup => Object.freeze({
      ...group,
      ordinal,
      callerIndices: Object.freeze([...group.callerIndices]),
      plannedGeneration: Object.freeze({ ...group.plannedGeneration }),
    }));
  const events = Object.freeze([
    ...operationEvents.map((event) => Object.freeze({ ...event })),
    ...statusGroups,
  ].sort((left, right) => left.index - right.index || left.contextIndex - right.contextIndex));
  const statusGroupSizeCounts: Record<string, number> = {};
  for (const group of statusGroups) incrementRecord(statusGroupSizeCounts, String(group.callerIndices.length));
  const sortedStatusGroupSizeCounts = Object.fromEntries(
    Object.entries(statusGroupSizeCounts).sort(([left], [right]) => Number(left) - Number(right)),
  );
  const underlyingScheduledOperations = operationCount - callerCounts.status + statusGroups.length;
  const expectedGenerationMovement = 2 * (
    callerCounts.mutation
    + callerCounts.fetch
    + callerCounts.topology
  );
  const setup = fixtureSetupCommandCount(config.commonDirectories, config.linkedWorktrees);
  const gitCommandExpectation = createGitCommandExpectation(
    {
      environment: 1,
      'fixture-setup': setup,
      discovery: config.worktreeIdentities,
      workload: statusGroups.length
        + callerCounts.diff
        + callerCounts.mutation
        + callerCounts.fetch
        + (callerCounts.topology * 2),
      'lock-recovery': 0,
      cleanup: callerCounts.topology,
    },
    {
      environment: 1,
      setup,
      discovery: config.worktreeIdentities,
      'soak-status': statusGroups.length,
      'soak-diff': callerCounts.diff,
      'soak-mutation': callerCounts.mutation,
      'soak-fetch': callerCounts.fetch,
      'soak-topology': callerCounts.topology * 2,
      'soak-topology-cleanup': callerCounts.topology,
    },
  );
  Object.freeze(gitCommandExpectation.byCategory);
  Object.freeze(gitCommandExpectation.byClass);
  Object.freeze(gitCommandExpectation);

  return Object.freeze({
    events,
    intervalMs,
    idleEvery,
    topologyEvery,
    statusWaveMs: SOAK_STATUS_WAVE_MS,
    callerCounts: Object.freeze({ ...callerCounts }),
    statusGroupSizeCounts: Object.freeze(sortedStatusGroupSizeCounts),
    expected: Object.freeze({
      logicalCallers: operationCount,
      coordinatorApiSubmissions: operationCount,
      underlyingScheduledOperations,
      statusGroups: statusGroups.length,
      generationMovement: expectedGenerationMovement,
    }),
    gitCommandExpectation,
  });
};

const summarizeSoakPlan = (plan: SoakPlan): GitExecutionSoakPlanSummary => Object.freeze({
  generatedBeforeExecution: true,
  statusGrouping: 'one-second wave + worktree + planned common/worktree generation + idle segment',
  statusWaveMs: plan.statusWaveMs,
  topologyEvery: plan.topologyEvery,
  idleEvery: plan.idleEvery,
  eventCount: plan.events.length,
  callerCounts: Object.freeze({ ...plan.callerCounts }),
  statusGroups: plan.expected.statusGroups,
  statusGroupSizeCounts: Object.freeze({ ...plan.statusGroupSizeCounts }),
  expected: Object.freeze({
    logicalCallers: plan.expected.logicalCallers,
    coordinatorApiSubmissions: plan.expected.coordinatorApiSubmissions,
    underlyingScheduledOperations: plan.expected.underlyingScheduledOperations,
    gitCommands: plan.gitCommandExpectation.total,
    generationMovement: plan.expected.generationMovement,
  }),
  gitCommandsByCategory: Object.freeze({ ...plan.gitCommandExpectation.byCategory }),
  gitCommandsByClass: Object.freeze({ ...plan.gitCommandExpectation.byClass }),
  gitCommandEquation: plan.gitCommandExpectation.equation,
});

const runSoak = async (
  fixture: RealFixture,
  modules: { coordinator: CoordinatorModule; resolver: ResolverModule },
  metrics: MetricsCollector,
  assertions: AssertionCollector,
  config: ProfileConfig,
  plan: SoakPlan,
  statusDelayPatternMs: readonly number[],
): Promise<ProfileOutcome> => {
  await createRealTopology(fixture, config.commonDirectories, config.linkedWorktrees);
  const mappingBefore = metrics.workSnapshot();
  const sessions = buildSessionRecords(config.sessionRecords, fixture.allWorktrees);
  const mappedWorktrees = new Set(sessions.map((session) => session.directory)).size;
  metrics.recordEntityMapping(true, sessions.length, mappedWorktrees, mappingBefore);
  metrics.declareScenario('soak', plan.expected.logicalCallers);
  const { resolver, contexts } = await resolveFixtureContexts(fixture, modules.resolver);
  const coordinator = modules.coordinator.createGitExecutionCoordinator({
    idleTtlMs: config.durationMs + 1_000,
    idlePruneIntervalMs: 25,
  });
  assertions.equal('soak entity mapping coordinator submissions', metrics.entityMapping.coordinatorApiSubmissions, 0);
  assertions.equal('soak entity mapping scheduled operations', metrics.entityMapping.underlyingScheduledOperations, 0);
  assertions.equal('soak entity mapping Git commands', metrics.entityMapping.gitCommands, 0);
  assertions.equal('soak planned worktree identities exact', mappedWorktrees, config.worktreeIdentities);
  assertions.equal('soak plan event count matches scheduled-operation expectation', plan.events.length, plan.expected.underlyingScheduledOperations);
  const intervalMs = plan.intervalMs;
  const startedAt = performance.now();
  const pending = new Set<Promise<void>>();
  const worktreeTails: Promise<void>[] = contexts.map(() => Promise.resolve());
  const contextIndicesByCommon = new Map<string, number[]>();
  for (const [contextIndex, context] of contexts.entries()) {
    const indices = contextIndicesByCommon.get(context.commonId) ?? [];
    indices.push(contextIndex);
    contextIndicesByCommon.set(context.commonId, indices);
  }
  let topologyChurn = 0;
  let idleChurn = 0;
  let evictedGenerationTotal = 0;

  const track = (promise: Promise<unknown>): Promise<void> => {
    const observed = promise.then(() => undefined, () => {
      metrics.unexpectedErrors += 1;
    });
    pending.add(observed);
    void observed.then(() => pending.delete(observed));
    return observed;
  };

  const scheduleAfter = (
    dependencies: readonly Promise<void>[],
    operation: () => Promise<unknown>,
  ): Promise<void> => track(Promise.all(dependencies).then(operation));

  const scheduleWorktreeOperation = (
    contextIndex: number,
    operation: () => Promise<unknown>,
  ): void => {
    const scheduled = scheduleAfter([worktreeTails[contextIndex]!], operation);
    worktreeTails[contextIndex] = scheduled;
  };

  const scheduleCommonBarrier = (
    contextIndex: number,
    operation: () => Promise<unknown>,
  ): void => {
    const context = contexts[contextIndex]!;
    const commonContextIndices = contextIndicesByCommon.get(context.commonId) ?? [contextIndex];
    const scheduled = scheduleAfter(
      commonContextIndices.map((index) => worktreeTails[index]!),
      operation,
    );
    for (const index of commonContextIndices) worktreeTails[index] = scheduled;
  };

  for (const event of plan.events) {
    const { index, contextIndex } = event;
    const targetTime = startedAt + (index * intervalMs);
    const waitMs = targetTime - performance.now();
    if (waitMs > 0) await sleep(waitMs);
    const context = contexts[contextIndex]!;
    const directory = fixture.allWorktrees[contextIndex]!;

    if (event.type === 'status-group') {
      const delayMs = statusDelayPatternMs.length === 0
        ? 0
        : statusDelayPatternMs[event.ordinal % statusDelayPatternMs.length]!;
      scheduleWorktreeOperation(contextIndex, async () => {
        const submissions = event.callerIndices.map(() => runStatus(
          coordinator,
          metrics,
          'soak',
          'soak-status',
          context,
          async () => {
            if (delayMs > 0) await sleep(delayMs);
            return fixture.runner.run(
              directory,
              ['status', '--porcelain=v1'],
              workloadOptions('soak-status', 'soak', [], null, true),
            ).then((result) => result.stdout);
          },
        ));
        await Promise.all(submissions);
      });
    } else if (event.type === 'topology') {
      const churnPath = path.join(fixture.root, 'soak-churn', `worktree-${index}`);
      topologyChurn += 1;
      scheduleCommonBarrier(contextIndex, () => runOperation(
          coordinator,
          metrics,
          'soak',
          'soak-topology',
          { context, kind: 'topology-write', label: `soak topology ${index}` },
          async () => {
            await makeFixtureDirectory(fixture, path.dirname(churnPath));
            await fixture.runner.run(
              directory,
              ['worktree', 'add', '--quiet', '--detach', churnPath, 'HEAD'],
              workloadOptions('soak-topology', 'soak', [churnPath]),
            );
            try {
              await fixture.runner.run(
                churnPath,
                ['status', '--porcelain=v1'],
                workloadOptions('soak-topology', 'soak', [], null, true),
              );
            } finally {
              await fixture.runner.run(
                directory,
                ['worktree', 'remove', '--force', churnPath],
                workloadCleanupOptions('soak-topology-cleanup', 'soak', [churnPath]),
              );
            }
          },
        ));
    } else if (event.type === 'diff') {
      track(runOperation(
        coordinator,
        metrics,
        'soak',
        'soak-diff',
        { context, kind: 'read', label: `soak diff ${index}` },
        async () => fixture.runner.run(
          directory,
          ['diff', '--stat'],
          workloadOptions('soak-diff', 'soak', [], null, true),
        ),
      ));
    } else if (event.type === 'mutation') {
      const relativePath = `soak-${index}.txt`;
      scheduleWorktreeOperation(contextIndex, () => runOperation(
          coordinator,
          metrics,
          'soak',
          'soak-mutation',
          { context, kind: 'worktree-write', label: `soak mutation ${index}` },
          async () => {
            await writeFixtureFile(fixture, path.join(directory, relativePath), `soak ${index}\n`);
            return fixture.runner.run(
              directory,
              ['add', '--', relativePath],
              workloadOptions('soak-mutation', 'soak', [relativePath]),
            );
          },
        ));
    } else {
      scheduleCommonBarrier(contextIndex, () => runOperation(
          coordinator,
          metrics,
          'soak',
          'soak-fetch',
          { context, kind: 'common-write', network: true, label: `soak fetch ${index}` },
          async () => fixture.runner.run(
            directory,
            ['fetch', '--quiet', 'origin'],
            workloadOptions('soak-fetch', 'soak', [], { kind: 'registered-alias', value: 'origin' }),
          ),
        ));
    }

    if (pending.size >= coordinator.getStats().limits.globalConcurrency * 4) {
      await Promise.race(pending);
    }
    if (index > 0 && index % plan.idleEvery === 0) {
      await Promise.all([...pending, ...worktreeTails]);
      await sleep(110);
      evictedGenerationTotal += generationTotal(coordinator, contexts);
      idleChurn += 1;
      coordinator.pruneIdle({ force: true });
      assertions.equal(`soak idle churn ${idleChurn} contexts evicted`, coordinator.getStats().contexts, 0);
    }
  }
  await Promise.all([...pending, ...worktreeTails]);
  const generation = evictedGenerationTotal + generationTotal(coordinator, contexts);
  const scenario = metrics.scenarioReport().soak;
  assertions.equal('soak logical caller count exact', scenario?.logicalCallers, plan.expected.logicalCallers);
  assertions.equal('soak API submission count exact', metrics.coordinatorSubmissions, plan.expected.coordinatorApiSubmissions);
  assertions.equal('soak scheduled-operation count exact', metrics.underlyingOperations, plan.expected.underlyingScheduledOperations);
  assertions.equal('soak status caller count exact', metrics.submissionsByClass['soak-status'] ?? 0, plan.callerCounts.status);
  assertions.equal('soak status group count exact', metrics.underlyingByClass['soak-status'] ?? 0, plan.expected.statusGroups);
  assertions.equal('soak status Git command count exact', metrics.gitCommandsByClass['soak-status'] ?? 0, plan.expected.statusGroups);
  assertions.equal('soak diff scheduled count exact', metrics.underlyingByClass['soak-diff'] ?? 0, plan.callerCounts.diff);
  assertions.equal('soak mutation scheduled count exact', metrics.underlyingByClass['soak-mutation'] ?? 0, plan.callerCounts.mutation);
  assertions.equal('soak fetch scheduled count exact', metrics.underlyingByClass['soak-fetch'] ?? 0, plan.callerCounts.fetch);
  assertions.equal('soak topology scheduled count exact', metrics.underlyingByClass['soak-topology'] ?? 0, plan.callerCounts.topology);
  assertions.equal('soak status waiter count exact', metrics.statusWaiters, plan.callerCounts.status);
  assertions.equal('soak status underlying count exact', metrics.statusUnderlying, plan.expected.statusGroups);
  assertions.equal('soak planned generation movement agrees with started mutations', metrics.expectedGenerationMovement, plan.expected.generationMovement);
  assertions.equal('soak generation movement exact across idle eviction', generation, plan.expected.generationMovement);
  assertions.equal('soak unexpected errors', metrics.unexpectedErrors, 0);
  assertions.atMost('soak global active cap respected', metrics.peakTopLevel, coordinator.getStats().limits.globalConcurrency);
  assertions.atMost('soak per-context read cap respected', metrics.peakPerContextReads, coordinator.getStats().limits.readsPerCommonContext);
  assertions.atMost('soak global network cap respected', metrics.peakGlobalNetwork, coordinator.getStats().limits.globalNetworkConcurrency);
  assertions.atMost('soak per-context network cap respected', metrics.peakPerContextNetwork, coordinator.getStats().limits.networkPerCommonContext);
  const lifecycle = assertDrainedAndEvict(coordinator, resolver, assertions);
  return {
    coordinator,
    resolver,
    contexts,
    generationTotal: generation,
    ...lifecycle,
    details: {
      manualProfile: true,
      operationCount: plan.expected.logicalCallers,
      topologyChurn,
      idleChurn,
      configuredDurationMs: config.durationMs,
      configuredRate: config.rate,
      statusDelayPatternApplied: statusDelayPatternMs.length > 0,
      immutablePlan: summarizeSoakPlan(plan),
    },
  };
};

const runCapSweep = async (
  modules: { coordinator: CoordinatorModule; resolver: ResolverModule },
  metrics: MetricsCollector,
  assertions: AssertionCollector,
  seed: number,
  config: ProfileConfig,
): Promise<ProfileOutcome> => {
  const random = new SeededRandom(seed);
  const contexts = Array.from({ length: 24 }, (_, index): ExecutionContext => ({
    isRepository: true,
    commonId: `/synthetic/common-${index}`,
    worktreeId: JSON.stringify([`/synthetic/common-${index}/.git`, `/synthetic/common-${index}`]),
  }));
  const fixtureOrder = random.shuffle(Array.from({ length: 240 }, (_, index) => ({
    index,
    contextIndex: index % contexts.length,
    network: index % 10 === 0,
    kind: index % 3 === 0 ? 'worktree-write' as const : 'read' as const,
    delayMs: 1 + (index % 3),
  })));
  metrics.recordEntityMapping(false, 0, 0, metrics.workSnapshot());
  metrics.declareScenario('cap-sweep', config.caps.length * fixtureOrder.length);
  const sweep: Array<Record<string, unknown>> = [];
  let lastCoordinator: CoordinatorLike | null = null;
  let baseThroughput = 0;
  let totalGeneration = 0;

  for (const cap of config.caps) {
    const coordinator = modules.coordinator.createGitExecutionCoordinator({
      globalConcurrency: cap,
      readsPerCommonContext: 2,
      globalNetworkConcurrency: 2,
    });
    lastCoordinator = coordinator;
    let active = 0;
    let peakActive = 0;
    const cpuStart = process.resourceUsage();
    const memoryStart = process.memoryUsage();
    const wallStart = performance.now();
    await Promise.all(fixtureOrder.map((spec) => runOperation(
      coordinator,
      metrics,
      'cap-sweep',
      `cap-${cap}`,
      {
        context: contexts[spec.contextIndex]!,
        kind: spec.kind,
        network: spec.network,
        label: `cap ${cap} operation ${spec.index}`,
      },
      async () => {
        active += 1;
        peakActive = Math.max(peakActive, active);
        await sleep(spec.delayMs);
        active -= 1;
        return spec.index;
      },
    )));
    const wallMs = performance.now() - wallStart;
    const cpuEnd = process.resourceUsage();
    const memoryEnd = process.memoryUsage();
    const throughput = fixtureOrder.length / (wallMs / 1_000);
    if (cap === config.caps[0]) baseThroughput = throughput;
    const finalStats = coordinator.getStats();
    assertions.atMost(`cap ${cap} active operations`, peakActive, cap);
    assertions.equal(`cap ${cap} final active`, finalStats.active, 0);
    assertions.equal(`cap ${cap} final pending`, finalStats.pending, 0);
    assertions.equal(`cap ${cap} final network`, finalStats.activeNetwork, 0);
    const capGenerationTotal = generationTotal(coordinator, contexts);
    const expectedCapGeneration = fixtureOrder.filter((spec) => spec.kind !== 'read').length * 2;
    totalGeneration += capGenerationTotal;
    assertions.equal(`cap ${cap} generation movement`, capGenerationTotal, expectedCapGeneration);
    coordinator.pruneIdle({ force: true });
    assertions.equal(`cap ${cap} contexts evicted`, coordinator.getStats().contexts, 0);
    sweep.push({
      cap,
      fixtureOperations: fixtureOrder.length,
      generationTotal: capGenerationTotal,
      peakActive,
      wallMs: round(wallMs),
      throughputPerSecond: round(throughput),
      throughputDeltaFromCap2Percent: baseThroughput === 0 ? 0 : round(((throughput / baseThroughput) - 1) * 100),
      cpuUserMicros: cpuEnd.userCPUTime - cpuStart.userCPUTime,
      cpuSystemMicros: cpuEnd.systemCPUTime - cpuStart.systemCPUTime,
      rssDeltaBytes: memoryEnd.rss - memoryStart.rss,
      heapDeltaBytes: memoryEnd.heapUsed - memoryStart.heapUsed,
      underlyingScheduledLatency: metrics.underlyingLatencyReport()[`cap-${cap}`],
      allWaitersObservedTotalMs: metrics.waiterLatencyReport()[`cap-${cap}`],
    });
  }
  assertions.equal('cap sweep does not change production default', config.caps.join(','), '2,4,6,8,12');
  assertions.equal('cap sweep unexpected errors', metrics.unexpectedErrors, 0);
  const finalCoordinator = lastCoordinator?.getStats() ?? null;
  return {
    coordinator: lastCoordinator,
    resolver: null,
    contexts,
    generationTotal: totalGeneration,
    retainedBeforeEviction: { contexts: 0, worktrees: 0 },
    finalCoordinator,
    finalResolver: null,
    details: {
      advisoryOnly: true,
      declaresOptimalCap: false,
      identicalFixtureOrder: true,
      sweep,
    },
  };
};

const deterministicModuleFixture = async (
  modules: { coordinator: CoordinatorModule; resolver: ResolverModule },
): Promise<Record<string, unknown>> => {
  const aliases = ['/a', '/b', '/c'];
  const discovery = new Map([
    ['/a', ['/repos/one', '/repos/one/.git', '/repos/one/.git']],
    ['/b', ['/repos/one-linked', '/repos/one/.git/worktrees/linked', '/repos/one/.git']],
    ['/c', ['/repos/two', '/repos/two/.git', '/repos/two/.git']],
  ]);
  let discoveryCalls = 0;
  const resolver = modules.resolver.createGitContextResolver({
    realpath: async (value) => value,
    runGit: async (cwd) => {
      discoveryCalls += 1;
      await Promise.resolve();
      const values = discovery.get(cwd)!;
      return { success: true, exitCode: 0, stdout: values.join('\n'), stderr: '' };
    },
  });
  const resolved = await Promise.all([...aliases, ...aliases, ...aliases].map((alias) => resolver.resolve(alias)));
  const contexts = resolved.filter((entry): entry is ExecutionContext => entry.isRepository === true).slice(0, 3);
  const coordinator = modules.coordinator.createGitExecutionCoordinator({ globalConcurrency: 4 });
  let statusTasks = 0;
  const statusResults = await Promise.all(Array.from({ length: 30 }, (_, index) => coordinator.runStatus({
    context: contexts[index % contexts.length]!,
    shape: 'full',
  }, async () => {
    statusTasks += 1;
    await Promise.resolve();
    return 'status';
  })));

  const events: string[] = [];
  const started = deferred<void>();
  const release = deferred<void>();
  const first = coordinator.run({ context: contexts[0]!, kind: modules.coordinator.GIT_OPERATION_KIND.READ }, async () => {
    events.push('read:start');
    started.resolve();
    await release.promise;
    events.push('read:end');
  });
  await started.promise;
  const writer = coordinator.run({ context: contexts[0]!, kind: modules.coordinator.GIT_OPERATION_KIND.WORKTREE_WRITE }, async () => {
    events.push('write');
  });
  const laterRead = coordinator.run({ context: contexts[0]!, kind: modules.coordinator.GIT_OPERATION_KIND.READ }, async () => {
    events.push('late-read');
  });
  await flushMicrotasks();
  const queuedEvents = [...events];
  release.resolve();
  await Promise.all([first, writer, laterRead]);

  await Promise.all(contexts.map((context) => coordinator.run({
    context,
    kind: modules.coordinator.GIT_OPERATION_KIND.COMMON_WRITE,
    network: true,
  }, async () => Promise.resolve('network'))));
  const generations = contexts.map((context) => coordinator.getGeneration(context));
  const retained = coordinator.getStats();
  coordinator.pruneIdle({ force: true });
  return {
    discoveryCalls,
    resolverStats: resolver.getStats(),
    commonCount: new Set(contexts.map((context) => context.commonId)).size,
    worktreeCount: new Set(contexts.map((context) => context.worktreeId)).size,
    statusResults: statusResults.length,
    statusTasks,
    queuedEvents,
    finalEvents: events,
    generations,
    retained: {
      active: retained.active,
      pending: retained.pending,
      activeNetwork: retained.activeNetwork,
      contexts: retained.contexts,
      worktrees: retained.worktrees,
      statusInFlight: retained.statusInFlight,
      clonePending: retained.clonePending,
      cloneDestinations: retained.cloneDestinations,
    },
    evicted: coordinator.getStats(),
  };
};

export const runCoordinatorParityAssertions = async (): Promise<{
  equal: boolean;
  web: Record<string, unknown>;
  vscode: Record<string, unknown>;
}> => {
  const [webModules, vscodeModules] = await Promise.all([loadWebModules(), loadVsCodeModules()]);
  const [web, vscode] = await Promise.all([
    deterministicModuleFixture(webModules),
    deterministicModuleFixture(vscodeModules),
  ]);
  return { equal: JSON.stringify(web) === JSON.stringify(vscode), web, vscode };
};

const resolveConfig = (profile: GitExecutionProfile, options: GitExecutionRunOptions): ProfileConfig => {
  const target = options.development ? DEVELOPMENT_TARGET_DEFAULTS : TARGET_DEFAULTS;
  const gitChildTimeoutMs = options.gitChildTimeoutMs ?? PROFILE_DEFAULTS.gitChildTimeoutMs;
  if (profile === 'pr-real') {
    return {
      development: false,
      gitChildTimeoutMs,
      ...PROFILE_DEFAULTS.prReal,
      startupCallers: PROFILE_DEFAULTS.prReal.worktreeIdentities,
      fanoutCallers: 0,
      mutations: 3,
      fetches: 1,
      durationMs: 0,
      rate: 0,
      caps: [...PROFILE_DEFAULTS.capSweep.caps],
    };
  }
  if (profile === 'target-real') {
    return {
      development: options.development === true,
      gitChildTimeoutMs,
      ...target,
      durationMs: 0,
      rate: 0,
      caps: [...PROFILE_DEFAULTS.capSweep.caps],
    };
  }
  if (profile === 'soak') {
    const commonDirectories = PROFILE_DEFAULTS.soak.commonDirectories;
    const linkedWorktrees = PROFILE_DEFAULTS.soak.linkedWorktrees;
    return {
      development: false,
      gitChildTimeoutMs,
      sessionRecords: (commonDirectories + linkedWorktrees) * 100,
      commonDirectories,
      linkedWorktrees,
      worktreeIdentities: commonDirectories + linkedWorktrees,
      startupCallers: 0,
      fanoutCallers: 0,
      mutations: 0,
      fetches: 0,
      durationMs: options.durationMs ?? PROFILE_DEFAULTS.soak.durationMs,
      rate: options.rate ?? PROFILE_DEFAULTS.soak.rate,
      caps: [...PROFILE_DEFAULTS.capSweep.caps],
    };
  }
  return {
    development: false,
    gitChildTimeoutMs,
    sessionRecords: 0,
    commonDirectories: 24,
    linkedWorktrees: 0,
    worktreeIdentities: 24,
    startupCallers: 0,
    fanoutCallers: 0,
    mutations: 0,
    fetches: 0,
    durationMs: 0,
    rate: 0,
    caps: [...PROFILE_DEFAULTS.capSweep.caps],
  };
};

const validateGitExecutionRunOptions = (
  profile: GitExecutionProfile,
  options: GitExecutionRunOptions,
): void => {
  if (profile !== 'soak' && options.durationMs !== undefined) {
    throw new Error('--duration-ms is only valid with --profile soak');
  }
  if (profile !== 'soak' && options.rate !== undefined) {
    throw new Error('--rate is only valid with --profile soak');
  }
  if (
    options.gitChildTimeoutMs !== undefined
    && (!Number.isFinite(options.gitChildTimeoutMs) || options.gitChildTimeoutMs <= 0)
  ) {
    throw new Error('--git-child-timeout-ms must be a positive number');
  }
  const timeoutProbe = options.testHooks?.gitChildTimeoutProbe;
  if (timeoutProbe && timeoutProbe.operationClass.trim() === '') {
    throw new Error('testHooks.gitChildTimeoutProbe.operationClass must not be empty');
  }
  if (
    timeoutProbe?.terminationGraceMs !== undefined
    && (!Number.isFinite(timeoutProbe.terminationGraceMs) || timeoutProbe.terminationGraceMs <= 0)
  ) {
    throw new Error('testHooks.gitChildTimeoutProbe.terminationGraceMs must be a positive number');
  }
};

export const inspectGitExecutionSoakPlan = (
  options: Pick<GitExecutionRunOptions, 'seed' | 'durationMs' | 'rate'> = {},
): GitExecutionSoakPlanSummary => {
  const seed = options.seed ?? PROFILE_DEFAULTS.seed;
  const config = resolveConfig('soak', options);
  return summarizeSoakPlan(buildSoakPlan(seed, config));
};

const fixtureSetupCommandCount = (commonDirectories: number, linkedWorktrees: number): number => (
  13 + (commonDirectories * 6) + linkedWorktrees
);

const nonZeroRecord = (record: Record<string, number>): Record<string, number> => Object.fromEntries(
  Object.entries(record).filter(([, value]) => value !== 0),
);

const createGitCommandExpectation = (
  byCategory: Record<GitCommandCategory, number>,
  byClass: Record<string, number>,
  expectedFailures = 0,
): GitCommandExpectation => {
  const total = sumRecord(byCategory);
  const normalizedByClass = nonZeroRecord(byClass);
  if (sumRecord(normalizedByClass) !== total) {
    throw new Error('Git command expectation category/class totals disagree');
  }
  return {
    byCategory,
    byClass: normalizedByClass,
    total,
    expectedSuccesses: total - expectedFailures,
    expectedFailures,
    equation: GIT_COMMAND_CATEGORIES
      .map((category) => `${byCategory[category]} ${category}`)
      .join(' + ') + ` = ${total}`,
  };
};

const resolveGitCommandExpectation = (
  profile: GitExecutionProfile,
  config: ProfileConfig,
  soakPlan: SoakPlan | null,
): GitCommandExpectation => {
  if (profile === 'pr-real') {
    return createGitCommandExpectation(
      {
        environment: 1,
        'fixture-setup': fixtureSetupCommandCount(1, 1),
        discovery: 2,
        workload: 6,
        'lock-recovery': 2,
        cleanup: 0,
      },
      {
        environment: 1,
        setup: fixtureSetupCommandCount(1, 1),
        discovery: 2,
        'startup-status': 2,
        'fairness-read': 1,
        'worktree-write': 1,
        'diff-read': 1,
        fetch: 1,
        'lock-write': 2,
      },
      1,
    );
  }
  if (profile === 'target-real') {
    const setup = fixtureSetupCommandCount(config.commonDirectories, config.linkedWorktrees);
    return createGitCommandExpectation(
      {
        environment: 1,
        'fixture-setup': setup,
        discovery: config.worktreeIdentities,
        workload: (config.worktreeIdentities * 2) + config.mutations + config.fetches,
        'lock-recovery': 2,
        cleanup: 0,
      },
      {
        environment: 1,
        setup,
        discovery: config.worktreeIdentities,
        'startup-status': config.worktreeIdentities,
        'pathological-fanout-status': config.worktreeIdentities,
        'mixed-mutation': config.mutations,
        'mixed-fetch': config.fetches,
        'lock-write': 2,
      },
      1,
    );
  }
  if (profile === 'soak') {
    if (!soakPlan) throw new Error('Soak command accounting requires the immutable execution plan');
    return soakPlan.gitCommandExpectation;
  }
  return createGitCommandExpectation(
    {
      environment: 1,
      'fixture-setup': 0,
      discovery: 0,
      workload: 0,
      'lock-recovery': 0,
      cleanup: 0,
    },
    { environment: 1 },
  );
};

const sortedRecord = (record: Record<string, number>): Record<string, number> => Object.fromEntries(
  Object.entries(nonZeroRecord(record)).sort(([left], [right]) => left.localeCompare(right)),
);

const assertGitCommandAccounting = (
  metrics: MetricsCollector,
  expected: GitCommandExpectation,
  assertions: AssertionCollector,
): void => {
  for (const category of GIT_COMMAND_CATEGORIES) {
    assertions.equal(`Git command category ${category} exact`, metrics.gitCommandsByCategory[category], expected.byCategory[category]);
  }
  const observedCategorySum = sumRecord(metrics.gitCommandsByCategory);
  const observedClassSum = sumRecord(metrics.gitCommandsByClass);
  assertions.equal('Git command category sum equals total', observedCategorySum, metrics.gitCommands);
  assertions.equal('Git command class sum equals total', observedClassSum, metrics.gitCommands);
  assertions.equal('Git command success and failure sum equals total', metrics.gitCommandSuccesses + metrics.gitCommandFailures, metrics.gitCommands);
  assertions.equal('Git command total matches reviewed profile equation', metrics.gitCommands, expected.total);
  assertions.equal('Git command successes match reviewed expectation', metrics.gitCommandSuccesses, expected.expectedSuccesses);
  assertions.equal('Git command failures match reviewed expectation', metrics.gitCommandFailures, expected.expectedFailures);
  assertions.deepEqual('Git command operation classes match reviewed expectation', sortedRecord(metrics.gitCommandsByClass), sortedRecord(expected.byClass));
};

const assertScenarioAccounting = (metrics: MetricsCollector, assertions: AssertionCollector): void => {
  const scenarios = Object.values(metrics.scenarioReport());
  assertions.equal(
    'scenario API submissions sum to coordinator API submissions',
    scenarios.reduce((total, scenario) => total + scenario.coordinatorApiSubmissions, 0),
    metrics.coordinatorSubmissions,
  );
  assertions.equal(
    'scenario scheduled operations sum to underlying scheduled operations',
    scenarios.reduce((total, scenario) => total + scenario.underlyingScheduledOperations, 0),
    metrics.underlyingOperations,
  );
  assertions.equal(
    'scenario Git commands sum to workload, lock, and cleanup commands',
    scenarios.reduce((total, scenario) => total + scenario.gitCommands, 0),
    metrics.gitCommandsByCategory.workload + metrics.gitCommandsByCategory['lock-recovery'] + metrics.gitCommandsByCategory.cleanup,
  );
  if (metrics.entityMapping.applicable) {
    assertions.equal('entity mapping performs zero coordinator API submissions', metrics.entityMapping.coordinatorApiSubmissions, 0);
    assertions.equal('entity mapping performs zero scheduled operations', metrics.entityMapping.underlyingScheduledOperations, 0);
    assertions.equal('entity mapping performs zero Git commands', metrics.entityMapping.gitCommands, 0);
  }
};

const assertLatencyAccounting = (metrics: MetricsCollector, assertions: AssertionCollector): void => {
  const waiterCounts = Object.fromEntries(
    Object.entries(metrics.waiterLatencyReport()).map(([operationClass, value]) => [operationClass, value.count]),
  );
  const underlyingCounts = Object.fromEntries(
    Object.entries(metrics.underlyingLatencyReport()).map(([operationClass, value]) => [operationClass, value.totalMs.count]),
  );
  assertions.deepEqual(
    'all-waiter latency has one sample per coordinator API submission by class',
    sortedRecord(waiterCounts),
    sortedRecord(metrics.submissionsByClass),
  );
  assertions.deepEqual(
    'underlying latency has one sample per started scheduled operation by class',
    sortedRecord(underlyingCounts),
    sortedRecord(metrics.underlyingByClass),
  );
  assertions.equal('all-waiter latency sample total equals coordinator API submissions', sumRecord(waiterCounts), metrics.coordinatorSubmissions);
  assertions.equal('underlying latency sample total equals scheduled operations', sumRecord(underlyingCounts), metrics.underlyingOperations);
};

const emptyCoordinatorStats = (): CoordinatorStats => ({
  active: 0,
  pending: 0,
  activeNetwork: 0,
  contexts: 0,
  idleContexts: 0,
  worktrees: 0,
  statusInFlight: 0,
  clonePending: 0,
  cloneDestinations: 0,
  limits: {
    globalConcurrency: 0,
    readsPerCommonContext: 0,
    networkPerCommonContext: 0,
    globalNetworkConcurrency: 0,
    maxQueuePerContext: 0,
    maxGlobalQueue: 0,
    maxContexts: 0,
    maxWorktrees: 0,
    maxStatusInFlight: 0,
    maxCloneQueue: 0,
    maxCloneQueuePerDestination: 0,
    maxCloneDestinations: 0,
    idleTtlMs: 0,
    idlePruneIntervalMs: 0,
  },
});

const unavailableSafetyReport = (outputBoundary: OutputBoundary): HarnessSafetyReport => {
  const guards = createSafetyGuardCounts();
  guards['output-boundary'].passed = 1;
  guards['fixture-path-boundary'].failed = 1;
  return {
    passed: false,
    fixtureBoundary: 'unique-os-temp-directory',
    outputBoundary: { mode: outputBoundary.mode, policy: outputBoundary.policy },
    guards,
    evidence: {
      childCwdChecksEqualGitCommands: false,
      childPathChecksEqualGitCommands: false,
      childEnvironmentChecksEqualGitCommands: false,
      childConfigurationChecksEqualGitCommands: false,
      remotePolicyChecksEqualGitCommands: false,
      failedGuardCodes: ['fixture-guard-unavailable'],
    },
    directChildAccountingCaveat: 'Counts direct Git children spawned by this harness; Git helpers and external processes are excluded.',
  };
};

const validateSoakStatusDelayPattern = (pattern: readonly number[] | undefined): readonly number[] => {
  const resolved = pattern ?? [];
  for (const delayMs of resolved) {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error('testHooks.soakStatusDelayPatternMs must contain only finite non-negative values');
    }
  }
  return resolved;
};

export const runGitExecutionProfile = async (
  options: GitExecutionRunOptions = {},
): Promise<GitExecutionReport> => {
  const profile = options.profile ?? 'pr-real';
  validateGitExecutionRunOptions(profile, options);
  const seed = options.seed ?? PROFILE_DEFAULTS.seed;
  const config = resolveConfig(profile, options);
  const statusDelayPatternMs = validateSoakStatusDelayPattern(options.testHooks?.soakStatusDelayPatternMs);
  const soakPlan = profile === 'soak' ? buildSoakPlan(seed, config) : null;
  const outputBoundary = await resolveOutputBoundary(options.output);
  const gitCommandExpectation = resolveGitCommandExpectation(profile, config, soakPlan);
  const metrics = new MetricsCollector();
  const assertions = new AssertionCollector();
  const resources = new ResourceSampler();
  const startedAt = performance.now();
  await resources.start();
  let fixture: RealFixture | null = null;
  let cleanupSucceeded = false;
  let gitVersion = 'unknown';
  let outcome: ProfileOutcome = {
    coordinator: null,
    resolver: null,
    contexts: [],
    generationTotal: 0,
    retainedBeforeEviction: { contexts: 0, worktrees: 0 },
    finalCoordinator: null,
    finalResolver: null,
    details: {},
  };

  try {
    fixture = await createHarnessRoot(metrics, outputBoundary, config.gitChildTimeoutMs, options.testHooks);
    const versionResult = await fixture.runner.run(fixture.root, ['--version'], {
      category: 'environment',
      operationClass: 'environment',
      scenario: null,
      paths: [],
      remote: null,
    });
    gitVersion = versionResult.stdout.trim();
    const modules = await loadWebModules();
    if (profile === 'pr-real') {
      outcome = await runPrReal(fixture, modules, metrics, assertions, seed);
    } else if (profile === 'target-real') {
      outcome = await runTargetReal(fixture, modules, metrics, assertions, seed, config);
    } else if (profile === 'soak') {
      outcome = await runSoak(fixture, modules, metrics, assertions, config, soakPlan!, statusDelayPatternMs);
    } else {
      outcome = await runCapSweep(modules, metrics, assertions, seed, config);
    }
  } catch (error) {
    metrics.unexpectedErrors += 1;
    assertions.results.push({
      name: 'profile completed without unexpected exception',
      passed: false,
      expected: 'no exception',
      actual: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
    outcome.details.unexpectedException = error instanceof Error ? {
      name: error.name,
      message: error.message,
    } : String(error);
  } finally {
    if (fixture) {
      try {
        await fixture.runner.waitForIdle();
      } catch (error) {
        metrics.unexpectedErrors += 1;
        assertions.results.push({
          name: 'harness-owned Git work settled before cleanup',
          passed: false,
          expected: 'all work settled',
          actual: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await removeFixturePath(fixture, fixture.root, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 50,
        });
        cleanupSucceeded = !existsSync(fixture.root);
      } catch {
        cleanupSucceeded = false;
      }
    }
  }

  await flushMicrotasks();
  const resourceReport = await resources.finish();
  assertGitCommandAccounting(metrics, gitCommandExpectation, assertions);
  assertScenarioAccounting(metrics, assertions);
  assertLatencyAccounting(metrics, assertions);
  if (fixture) fixture.guard.assertComplete(metrics.gitCommands, assertions);
  else assertions.truthy('runtime safety fixture guard was created', false);
  assertions.equal('Git child timeouts are zero', metrics.gitChildTimeouts, 0);
  assertions.equal(
    'timed out Git children are reaped before release',
    metrics.gitChildReapedAfterTimeout,
    metrics.gitChildTimeouts,
  );
  assertions.equal(
    'timed out Git children receive one termination attempt',
    metrics.gitChildTerminationAttempts,
    metrics.gitChildTimeouts,
  );
  assertions.equal(
    'timed out Git children close gracefully or after force escalation',
    metrics.gitChildGracefulTerminations + metrics.gitChildForcedTerminations,
    metrics.gitChildTimeouts,
  );
  assertions.equal('unexpected errors are zero', metrics.unexpectedErrors, 0);
  assertions.equal('harness coordinator submissions drained', metrics.activeSubmissions, 0);
  assertions.equal('harness Git children drained', metrics.activeGitChildren, 0);
  assertions.truthy('temporary fixture cleanup succeeded', cleanupSucceeded);
  if (resourceReport.fd.start !== null && resourceReport.fd.end !== null) {
    assertions.atMost(
      'Linux FD count returned within tolerance',
      Math.abs(resourceReport.fd.end - resourceReport.fd.start),
      FD_TOLERANCE,
    );
  }

  const uniqueCommonDirectories = new Set(outcome.contexts.map((context) => context.commonId)).size;
  const uniqueWorktreeIdentities = new Set(outcome.contexts.map((context) => context.worktreeId)).size;
  const finalCoordinator = outcome.finalCoordinator ?? outcome.coordinator?.getStats() ?? null;
  const finalResolver = outcome.finalResolver ?? outcome.resolver?.getStats() ?? null;
  const durationMs = performance.now() - startedAt;
  const versions = process.versions as NodeJS.ProcessVersions & { bun?: string };
  const safetyReport = fixture?.guard.report(metrics.gitCommands) ?? unavailableSafetyReport(outputBoundary);
  const observedCategorySum = sumRecord(metrics.gitCommandsByCategory);
  const observedClassSum = sumRecord(metrics.gitCommandsByClass);
  const report: GitExecutionReport = {
    schemaVersion: 2,
    profile,
    seed,
    passed: assertions.passed,
    durationMs: round(durationMs),
    config,
    environment: {
      platform: process.platform,
      architecture: process.arch,
      gitVersion,
      bunVersion: versions.bun ?? null,
      nodeVersion: process.version,
      cpuCount: typeof availableParallelism === 'function' ? availableParallelism() : cpus().length,
      fdMeasurement: process.platform === 'linux' ? 'linux-procfs' : 'unsupported',
      gitChildScope: 'Direct Git children spawned by this harness only; excludes Git helpers and external processes.',
      cpuScope: 'Harness process user/system CPU only; child-process CPU is excluded.',
    },
    cardinality: {
      sessionEntities: metrics.sessionEntities,
      uniqueCommonDirectories,
      uniqueWorktreeIdentities,
      entityMapping: metrics.entityMapping,
      scenarios: metrics.scenarioReport(),
      coordinatorApiSubmissions: metrics.coordinatorSubmissions,
      underlyingScheduledOperations: metrics.underlyingOperations,
      gitCommands: metrics.gitCommands,
    },
    operations: {
      coordinatorApiSubmissionsByClass: metrics.submissionsByClass,
      underlyingScheduledOperationsByClass: metrics.underlyingByClass,
      gitCommandsByCategory: metrics.gitCommandsByCategory,
      gitCommandsByClass: metrics.gitCommandsByClass,
      gitCommandAccounting: {
        closedCategories: [...GIT_COMMAND_CATEGORIES],
        expectedByCategory: gitCommandExpectation.byCategory,
        observedCategorySum,
        expectedByClass: gitCommandExpectation.byClass,
        observedClassSum,
        expectedTotal: gitCommandExpectation.total,
        expectedSuccesses: gitCommandExpectation.expectedSuccesses,
        expectedFailures: gitCommandExpectation.expectedFailures,
        equation: gitCommandExpectation.equation,
      },
      gitCommandSuccesses: metrics.gitCommandSuccesses,
      gitCommandFailures: metrics.gitCommandFailures,
      statusWaiters: metrics.statusWaiters,
      statusUnderlyingScheduledOperations: metrics.statusUnderlying,
    },
    latency: {
      contract: {
        underlyingScheduledOperations: 'one queue/service/total sample per task that actually starts',
        allWaitersObservedTotalMs: 'one exact observed-total sample per coordinator API submission',
      },
      underlyingScheduledOperations: metrics.underlyingLatencyReport(),
      allWaitersObservedTotalMs: metrics.waiterLatencyReport(),
    },
    safety: safetyReport,
    peaks: {
      topLevelOperations: metrics.peakTopLevel,
      coordinatorActive: metrics.peakCoordinatorActive,
      coordinatorPending: metrics.peakCoordinatorPending,
      globalReads: metrics.peakGlobalReads,
      perContextReads: metrics.peakPerContextReads,
      globalNetwork: metrics.peakGlobalNetwork,
      perContextNetwork: metrics.peakPerContextNetwork,
      statusInFlight: metrics.peakStatusInFlight,
      harnessGitChildren: metrics.peakGitChildren,
    },
    resources: resourceReport,
    lifecycle: {
      generationTotal: outcome.generationTotal,
      expectedGenerationMovement: metrics.expectedGenerationMovement,
      expectedErrors: metrics.expectedErrors,
      unexpectedErrors: metrics.unexpectedErrors,
      overloads: metrics.overloads,
      lockFailures: metrics.lockFailures,
      lockRetries: metrics.lockRetries,
      gitChildTimeouts: metrics.gitChildTimeouts,
      gitChildTerminationAttempts: metrics.gitChildTerminationAttempts,
      gitChildGracefulTerminations: metrics.gitChildGracefulTerminations,
      gitChildForcedTerminations: metrics.gitChildForcedTerminations,
      gitChildReapedAfterTimeout: metrics.gitChildReapedAfterTimeout,
      retainedBeforeEviction: outcome.retainedBeforeEviction,
      finalCoordinator: finalCoordinator ?? emptyCoordinatorStats(),
      finalResolver,
      activeHarnessSubmissions: metrics.activeSubmissions,
      activeHarnessGitChildren: metrics.activeGitChildren,
      fixtureCleanupSucceeded: cleanupSucceeded,
    },
    details: outcome.details,
    assertions: assertions.results,
  };
  report.passed = report.assertions.every((assertion) => assertion.passed);
  if (outputBoundary.canonicalOutputPath) {
    const handle = await open(outputBoundary.canonicalOutputPath, 'wx');
    try {
      await handle.writeFile(`${JSON.stringify(report, null, JSON_INDENT)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  }
  return report;
};

const FOCUSED_SOAK_MAX_DURATION_MS = 30_000;

export const runFocusedGitExecutionProfile = async (
  options: GitExecutionRunOptions = {},
): Promise<GitExecutionReport> => {
  const profile = options.profile ?? 'pr-real';
  if (profile === 'target-real' && options.development !== true) {
    throw new Error('Focused test entrypoint forbids full target-real; use the perf:git:target-real package script');
  }
  if (
    profile === 'soak'
    && (options.durationMs === undefined || options.durationMs > FOCUSED_SOAK_MAX_DURATION_MS)
  ) {
    throw new Error('Focused test entrypoint requires an explicit soak duration of at most 30000ms');
  }
  return runGitExecutionProfile(options);
};

const parsePositiveNumber = (name: string, value: string | undefined): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
};

const parseSeed = (value: string | undefined): number => {
  if (!value) return PROFILE_DEFAULTS.seed;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error('--seed must be a non-negative integer');
  return parsed;
};

export const parseGitExecutionCliArgs = (args: string[]): GitExecutionRunOptions & { help?: boolean } => {
  const options: GitExecutionRunOptions & { help?: boolean } = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--') continue;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--profile') {
      const profile = args[++index] as GitExecutionProfile | undefined;
      if (!profile || !['pr-real', 'target-real', 'soak', 'cap-sweep'].includes(profile)) {
        throw new Error('--profile must be pr-real, target-real, soak, or cap-sweep');
      }
      options.profile = profile;
    } else if (arg === '--seed') {
      options.seed = parseSeed(args[++index]);
    } else if (arg === '--development') {
      options.development = true;
    } else if (arg === '--git-child-timeout-ms') {
      options.gitChildTimeoutMs = parsePositiveNumber('--git-child-timeout-ms', args[++index]);
    } else if (arg === '--duration-ms') {
      options.durationMs = parsePositiveNumber('--duration-ms', args[++index]);
    } else if (arg === '--rate') {
      options.rate = parsePositiveNumber('--rate', args[++index]);
    } else if (arg === '--output') {
      const output = args[++index];
      if (!output) throw new Error('--output requires a path');
      options.output = output;
    } else if (arg === '--human') {
      options.human = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.help) validateGitExecutionRunOptions(options.profile ?? 'pr-real', options);
  return options;
};

const usage = `Usage: bun scripts/perf/git-execution.ts [options]

Options:
  --profile <pr-real|target-real|soak|cap-sweep>  Profile (default: pr-real)
  --seed <integer>                               Deterministic seed (default: 8755)
  --development                                  Reduced target-real topology
  --git-child-timeout-ms <number>                Per-Git-child timeout (default: 60000)
  --duration-ms <number>                         Soak-only duration override
  --rate <number>                                Soak-only logical callers/second override
  --output <path>                                Also write JSON to this explicit path
  --human                                        Print a concise summary to stderr
  --help                                         Show this help
`;

const printHumanSummary = (report: GitExecutionReport): void => {
  const failed = report.assertions.filter((assertion) => !assertion.passed);
  const scenarioCallers = Object.values(report.cardinality.scenarios)
    .reduce((total, scenario) => total + scenario.logicalCallers, 0);
  console.error([
    `${report.profile}: ${report.passed ? 'PASS' : 'FAIL'} (${report.durationMs}ms, seed ${report.seed})`,
    `session entities/scenario callers/API submissions: ${report.cardinality.sessionEntities}/${scenarioCallers}/${report.cardinality.coordinatorApiSubmissions}`,
    `underlying scheduled/Git commands: ${report.cardinality.underlyingScheduledOperations}/${report.cardinality.gitCommands}`,
    `peak top-level/Git children: ${report.peaks.topLevelOperations}/${report.peaks.harnessGitChildren}`,
    `unexpected/lock failures/retries: ${report.lifecycle.unexpectedErrors}/${report.lifecycle.lockFailures}/${report.lifecycle.lockRetries}`,
    `failed assertions: ${failed.length}`,
  ].join('\n'));
};

const isMain = (import.meta as ImportMeta & { main?: boolean }).main === true;
if (isMain) {
  try {
    const options = parseGitExecutionCliArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage);
    } else {
      const report = await runGitExecutionProfile(options);
      const json = `${JSON.stringify(report, null, JSON_INDENT)}\n`;
      process.stdout.write(json);
      if (options.human) printHumanSummary(report);
      if (!report.passed) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
