/**
 * Architecture-neutral before/after/after+fsmonitor benchmark for the exported web Git service.
 *
 * The historical service is materialized under an OS temporary directory and
 * all targets run in isolated child processes against equivalent
 * disposable local repositories. Reports are JSON and generated artifacts are
 * never retained unless --output names one new file outside the workspace.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type GitServiceComparisonProfile = 'smoke' | 'target' | 'pathological-fanout';

type WorkloadConfig = {
  sessionRecords: number;
  commonDirectories: number;
  linkedWorktrees: number;
  worktreeIdentities: number;
  startupCallers: number;
  fanoutCallers: number;
  fanoutBatchSize: number;
  mutations: number;
  fetches: number;
};

type Distribution = {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
};

type ScenarioReport = {
  logicalCallers: number;
  durationMs: number;
  gitLaunches: number;
};

type CorrectnessReport = {
  checks: number;
  failures: number;
  failureSamples: string[];
};

export type GitServiceTargetReport = {
  label:
    | 'before'
    | 'after'
    | 'after-fsmonitor'
    | 'control-before'
    | 'control-after'
    | 'control-after-fsmonitor';
  passed: boolean;
  profile: GitServiceComparisonProfile;
  sourceHash: string;
  durationMs: number;
  throughputCallsPerSecond: number;
  cardinality: {
    sessionEntities: number;
    uniqueCommonDirectories: number;
    uniqueWorktreeIdentities: number;
    serviceCalls: number;
  };
  scenarios: {
    entityMapping: ScenarioReport;
    coldStatus: ScenarioReport;
    warmStatus: ScenarioReport;
    pathologicalFanout: ScenarioReport | null;
    mixedWorkload: ScenarioReport;
  };
  latencyMs: {
    coldStatus: Distribution;
    warmStatus: Distribution;
    pathologicalFanoutStatus: Distribution | null;
    mutation: Distribution;
    fetch: Distribution;
  };
  gitProcesses: {
    scope: 'top-level service-started git executable launches';
    instrumentation: 'POSIX PATH shim logs once and execs the real Git binary';
    totalLaunches: number;
    unclassifiedLaunches: number;
  };
  resources: {
    scope: 'benchmark worker process; child Git CPU is excluded';
    cpuUserMicros: number;
    cpuSystemMicros: number;
    rssStartBytes: number;
    rssEndBytes: number;
    heapStartBytes: number;
    heapEndBytes: number;
  };
  fsmonitor: {
    mode: 'disabled' | 'fixture-hook-v2';
    configurationOwner: 'Git fixture local config';
    configuredCommonDirectories: number;
    configurationPreserved: boolean | null;
    protocolVersion: 2 | null;
    invocations: number;
    invocationsByScenario: Record<string, number>;
    coldResponses: number;
    warmResponses: number;
    refreshResponses: number;
    unexpectedVersions: string[];
    unclassifiedInvocations: number;
  };
  correctness: CorrectnessReport;
  cleanupSucceeded: boolean;
  operationalError: { name: string; message: string } | null;
};

type ComparisonDelta = {
  before: number;
  after: number;
  ratioBeforeOverAfter: number | null;
  reduction: number;
  reductionPercent: number | null;
};

export type GitServiceComparisonReport = {
  schemaVersion: 2;
  passed: boolean;
  profile: GitServiceComparisonProfile;
  seed: number;
  baseline: {
    requestedRef: string;
    resolvedRef: string;
    architectureCommit: string;
    verifiedDirectParent: boolean;
  };
  environment: {
    platform: NodeJS.Platform;
    architecture: string;
    gitVersion: string;
    bunVersion: string | null;
    nodeVersion: string;
    dependencyPolicy: 'same current installed dependency tree for before, after, and after-fsmonitor';
    runOrder:
      | ['before', 'after', 'after-fsmonitor']
      | ['after-fsmonitor', 'after', 'before'];
  };
  config: WorkloadConfig;
  before: GitServiceTargetReport;
  after: GitServiceTargetReport;
  afterFsmonitor: GitServiceTargetReport;
  comparison: {
    valid: boolean;
    beforeToAfter: {
      workloadDurationMs: ComparisonDelta;
      workloadGitLaunches: ComparisonDelta;
      coldStatusP95Ms: ComparisonDelta;
      warmStatusP95Ms: ComparisonDelta;
      mutationP95Ms: ComparisonDelta;
      fetchP95Ms: ComparisonDelta;
      pathologicalFanoutP95Ms: ComparisonDelta | null;
    };
    afterToAfterFsmonitor: {
      workloadDurationMs: ComparisonDelta;
      workloadGitLaunches: ComparisonDelta;
      coldStatusP95Ms: ComparisonDelta;
      warmStatusP95Ms: ComparisonDelta;
      mutationP95Ms: ComparisonDelta;
      fetchP95Ms: ComparisonDelta;
      pathologicalFanoutP95Ms: ComparisonDelta | null;
    };
    interpretation: string[];
  };
};

type ServiceStatus = {
  files?: Array<{ path?: string }>;
  isClean?: boolean;
};

type GitServiceModule = {
  getStatus: (directory: string, options?: { mode?: 'light' }) => Promise<ServiceStatus>;
  stageFile: (directory: string, filePath: string) => Promise<void>;
  fetch: (directory: string, options?: { remote?: string }) => Promise<{ success?: boolean }>;
};

type WorkerConfig = {
  label: GitServiceTargetReport['label'];
  profile: GitServiceComparisonProfile;
  workload: WorkloadConfig;
  seed: number;
  servicePath: string;
  sourceHash: string;
  comparisonRoot: string;
  fixtureRoot: string;
  realGit: string;
  fsmonitorMode: GitServiceTargetReport['fsmonitor']['mode'];
};

type CliOptions = {
  profile: GitServiceComparisonProfile;
  baselineRef: string;
  seed: number;
  output?: string;
  allowPathological: boolean;
  order: 'before-first' | 'after-first';
  workerConfig?: string;
};

type Fixture = {
  root: string;
  directEnvironment: NodeJS.ProcessEnv;
  measuredEnvironment: NodeJS.ProcessEnv;
  tracePath: string;
  primaryWorktrees: string[];
  linkedWorktrees: string[];
  allWorktrees: string[];
  fsmonitor: {
    mode: GitServiceTargetReport['fsmonitor']['mode'];
    tracePath: string;
    configurations: Array<{ directory: string; hookPath: string }>;
  };
};

type FsmonitorInvocation = {
  scenario: string;
  version: string;
  response: string;
};

type ProcessResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const WORKSPACE_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '../..');
const CURRENT_SERVICE_PATH = path.join(WORKSPACE_ROOT, 'packages/web/server/lib/git/service.js');
const HISTORICAL_SERVICE_REPOSITORY_PATH = 'packages/web/server/lib/git/service.js';
const DEFAULT_BASELINE_REF = '4c2f8946b';
const ARCHITECTURE_COMMIT = '57c297527';
const DEFAULT_SEED = 0x2233;
const MAX_ERROR_SAMPLES = 20;
const PROCESS_OUTPUT_LIMIT = 4 * 1024 * 1024;
const FSMONITOR_TOKEN = 'openchamber-git-service-comparison-v1';
const SAFE_RUNTIME_ENVIRONMENT_KEYS = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'SYSTEMROOT',
  'COMSPEC',
  'PATHEXT',
  'WINDIR',
] as const;

const SMOKE_CONFIG = Object.freeze<WorkloadConfig>({
  sessionRecords: 60,
  commonDirectories: 2,
  linkedWorktrees: 1,
  worktreeIdentities: 3,
  startupCallers: 3,
  fanoutCallers: 0,
  fanoutBatchSize: 0,
  mutations: 6,
  fetches: 2,
});

const TARGET_CONFIG = Object.freeze<WorkloadConfig>({
  sessionRecords: 30_000,
  commonDirectories: 200,
  linkedWorktrees: 100,
  worktreeIdentities: 300,
  startupCallers: 300,
  fanoutCallers: 0,
  fanoutBatchSize: 0,
  mutations: 600,
  fetches: 60,
});

const PATHOLOGICAL_CONFIG = Object.freeze<WorkloadConfig>({
  ...TARGET_CONFIG,
  fanoutCallers: 30_000,
  fanoutBatchSize: 600,
});

export const GIT_SERVICE_COMPARISON_DEFAULTS = Object.freeze({
  seed: DEFAULT_SEED,
  baselineRef: DEFAULT_BASELINE_REF,
  architectureCommit: ARCHITECTURE_COMMIT,
  smoke: SMOKE_CONFIG,
  target: TARGET_CONFIG,
  pathologicalFanout: PATHOLOGICAL_CONFIG,
});

const round = (value: number, digits = 3): number => {
  if (!Number.isFinite(value)) return 0;
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
};

const percentile = (values: number[], target: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((target / 100) * sorted.length) - 1));
  return round(sorted[index] ?? 0);
};

const distribution = (values: number[]): Distribution => ({
  count: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  p99: percentile(values, 99),
  max: round(values.length > 0 ? Math.max(...values) : 0),
});

const ratio = (before: number, after: number): number | null => (
  after === 0 ? null : round(before / after)
);

const delta = (before: number, after: number): ComparisonDelta => {
  const reduction = before - after;
  return {
    before: round(before),
    after: round(after),
    ratioBeforeOverAfter: ratio(before, after),
    reduction: round(reduction),
    reductionPercent: before === 0 ? null : round((reduction / before) * 100),
  };
};

const workloadForProfile = (profile: GitServiceComparisonProfile): WorkloadConfig => {
  if (profile === 'smoke') return { ...SMOKE_CONFIG };
  if (profile === 'target') return { ...TARGET_CONFIG };
  return { ...PATHOLOGICAL_CONFIG };
};

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  integer(maxExclusive: number): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return Math.floor((this.state / 0x1_0000_0000) * maxExclusive);
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

class CorrectnessCollector {
  checks = 0;
  failures = 0;
  readonly failureSamples: string[] = [];

  check(condition: unknown, message: string): void {
    this.checks += 1;
    if (condition) return;
    this.failures += 1;
    if (this.failureSamples.length < MAX_ERROR_SAMPLES) this.failureSamples.push(message);
  }

  fail(message: string): void {
    this.check(false, message);
  }

  report(): CorrectnessReport {
    return {
      checks: this.checks,
      failures: this.failures,
      failureSamples: [...this.failureSamples],
    };
  }
}

const mapLimit = async <T, R>(
  values: T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> => {
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

const appendLimited = (buffers: Buffer[], chunk: Buffer, state: { bytes: number }): void => {
  if (state.bytes >= PROCESS_OUTPUT_LIMIT) return;
  const remaining = PROCESS_OUTPUT_LIMIT - state.bytes;
  const retained = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
  buffers.push(retained);
  state.bytes += retained.length;
};

const runProcess = async (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    detached?: boolean;
  },
): Promise<ProcessResult> => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    detached: options.detached === true,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const stdoutState = { bytes: 0 };
  const stderrState = { bytes: 0 };
  let timedOut = false;
  let settled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (child.pid && options.detached && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // The process may already be closing.
      }
    } else {
      child.kill('SIGTERM');
    }
    setTimeout(() => {
      if (settled) return;
      if (child.pid && options.detached && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The process may already be closed.
        }
      } else {
        child.kill('SIGKILL');
      }
    }, 1_000).unref();
  }, options.timeoutMs);
  timer.unref();

  child.stdout.on('data', (chunk: Buffer) => appendLimited(stdout, chunk, stdoutState));
  child.stderr.on('data', (chunk: Buffer) => appendLimited(stderr, chunk, stderrState));
  child.once('error', (error) => {
    settled = true;
    clearTimeout(timer);
    reject(error);
  });
  child.once('close', (exitCode) => {
    settled = true;
    clearTimeout(timer);
    resolve({
      exitCode: exitCode ?? -1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
      timedOut,
    });
  });
});

const isWithin = (boundary: string, candidate: string): boolean => {
  const relative = path.relative(boundary, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

const sanitizeMessage = (message: string, replacements: Array<[string, string]>): string => {
  let result = String(message || 'Unknown error');
  for (const [value, replacement] of replacements) {
    if (!value) continue;
    result = result.split(value).join(replacement);
  }
  return result.slice(0, 1_000);
};

const describeError = (error: unknown, replacements: Array<[string, string]>): { name: string; message: string } => {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : String(error);
  return { name, message: sanitizeMessage(message, replacements) };
};

const hashSource = (source: string): string => createHash('sha256').update(source).digest('hex');

const resolveExecutable = async (name: string, environmentPath = process.env.PATH ?? ''): Promise<string> => {
  const candidates = process.platform === 'win32' ? [`${name}.exe`, name] : [name];
  for (const directory of environmentPath.split(path.delimiter)) {
    if (!directory) continue;
    for (const candidateName of candidates) {
      const candidate = path.join(directory, candidateName);
      try {
        await access(candidate, fsConstants.X_OK);
        return await realpath(candidate);
      } catch {
        // Continue searching PATH.
      }
    }
  }
  throw new Error(`${name} is not available on PATH`);
};

const createSanitizedEnvironment = (
  root: string,
  globalConfig: string,
  askpass: string,
  originalPath: string,
): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_RUNTIME_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.PATH = originalPath;
  environment.HOME = path.join(root, 'home');
  environment.XDG_CONFIG_HOME = path.join(root, 'xdg-config');
  environment.XDG_DATA_HOME = path.join(root, 'xdg-data');
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = globalConfig;
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.GIT_ASKPASS = askpass;
  environment.SSH_ASKPASS = askpass;
  environment.GCM_INTERACTIVE = 'never';
  environment.GIT_LFS_SKIP_SMUDGE = '1';
  environment.SSH_AUTH_SOCK = path.join(root, 'disabled-ssh-agent.sock');
  return environment;
};

const createWorkerEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of SAFE_RUNTIME_ENVIRONMENT_KEYS) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
};

const createRepositoryGitEnvironment = (): NodeJS.ProcessEnv => {
  const environment = createWorkerEnvironment();
  if (process.env.HOME) environment.HOME = process.env.HOME;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
};

const runGit = async (
  fixtureRoot: string,
  realGit: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
): Promise<string> => {
  if (!isWithin(fixtureRoot, path.resolve(cwd))) throw new Error('Git fixture cwd escaped its temporary root');
  const result = await runProcess(realGit, args, { cwd, env: environment, timeoutMs: 60_000 });
  if (result.timedOut) throw new Error(`Fixture Git command timed out: git ${args[0] ?? ''}`);
  if (result.exitCode !== 0) {
    throw new Error(`Fixture Git command failed: git ${args[0] ?? ''}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout;
};

const createFixture = async (config: WorkerConfig): Promise<Fixture> => {
  if (process.platform === 'win32') {
    throw new Error('Exact Git launch counting currently requires a POSIX PATH shim');
  }
  const root = path.resolve(config.fixtureRoot);
  await mkdir(root, { recursive: false });
  const hooksDirectory = path.join(root, 'disabled-hooks');
  const homeDirectory = path.join(root, 'home');
  const xdgConfig = path.join(root, 'xdg-config');
  const xdgData = path.join(root, 'xdg-data');
  const shimDirectory = path.join(root, 'git-shim');
  const fsmonitorDirectory = path.join(root, 'fsmonitor-hooks');
  const globalConfig = path.join(root, 'global.gitconfig');
  const askpass = path.join(root, 'disabled-askpass');
  const tracePath = path.join(root, 'git-launches.log');
  const fsmonitorTracePath = path.join(root, 'fsmonitor-invocations.log');
  await Promise.all([
    mkdir(hooksDirectory, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
    mkdir(xdgConfig, { recursive: true }),
    mkdir(xdgData, { recursive: true }),
    mkdir(shimDirectory, { recursive: true }),
    mkdir(fsmonitorDirectory, { recursive: true }),
  ]);
  await writeFile(globalConfig, '', 'utf8');
  await writeFile(askpass, '#!/bin/sh\nexit 1\n', 'utf8');
  await chmod(askpass, 0o700);
  const originalPath = process.env.PATH ?? '';
  const directEnvironment = createSanitizedEnvironment(root, globalConfig, askpass, originalPath);

  await runGit(root, config.realGit, directEnvironment, root, ['config', '--file', globalConfig, 'core.hooksPath', hooksDirectory]);
  await runGit(root, config.realGit, directEnvironment, root, ['config', '--file', globalConfig, 'gc.auto', '0']);
  await runGit(root, config.realGit, directEnvironment, root, ['config', '--file', globalConfig, 'maintenance.auto', 'false']);
  await runGit(root, config.realGit, directEnvironment, root, ['config', '--file', globalConfig, 'user.name', 'OpenChamber Comparison']);
  await runGit(root, config.realGit, directEnvironment, root, ['config', '--file', globalConfig, 'user.email', 'comparison@openchamber.invalid']);

  const seedRepository = path.join(root, 'seed');
  const bareRemote = path.join(root, 'remote.git');
  await mkdir(seedRepository, { recursive: true });
  await runGit(root, config.realGit, directEnvironment, seedRepository, ['init', '--quiet']);
  await runGit(root, config.realGit, directEnvironment, seedRepository, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  await writeFile(path.join(seedRepository, 'README.md'), '# OpenChamber Git comparison fixture\n', 'utf8');
  await runGit(root, config.realGit, directEnvironment, seedRepository, ['add', '--', 'README.md']);
  await runGit(root, config.realGit, directEnvironment, seedRepository, ['commit', '--quiet', '-m', 'Initial fixture']);
  await runGit(root, config.realGit, directEnvironment, root, ['clone', '--quiet', '--bare', seedRepository, bareRemote]);

  const repositoriesRoot = path.join(root, 'repositories');
  await mkdir(repositoriesRoot, { recursive: true });
  const primaryWorktrees = await mapLimit(
    Array.from({ length: config.workload.commonDirectories }, (_, index) => index),
    8,
    async (index) => {
      const destination = path.join(repositoriesRoot, `repository-${index}`);
      await runGit(root, config.realGit, directEnvironment, root, ['clone', '--quiet', bareRemote, destination]);
      return destination;
    },
  );

  const linkedRoot = path.join(root, 'linked-worktrees');
  await mkdir(linkedRoot, { recursive: true });
  const linkedWorktrees = await mapLimit(
    Array.from({ length: config.workload.linkedWorktrees }, (_, index) => index),
    8,
    async (index) => {
      const owner = primaryWorktrees[index % primaryWorktrees.length]!;
      const destination = path.join(linkedRoot, `worktree-${index}`);
      await runGit(root, config.realGit, directEnvironment, owner, [
        'worktree', 'add', '--quiet', '--detach', destination, 'HEAD',
      ]);
      return destination;
    },
  );
  const allWorktrees = [...primaryWorktrees, ...linkedWorktrees];
  await Promise.all(allWorktrees.map((directory, index) => (
    writeFile(path.join(directory, `identity-${index}.txt`), `identity ${index}\n`, 'utf8')
  )));

  await writeFile(fsmonitorTracePath, '', 'utf8');
  const fsmonitorConfigurations: Array<{ directory: string; hookPath: string }> = [];
  if (config.fsmonitorMode === 'fixture-hook-v2') {
    await mapLimit(primaryWorktrees, 8, async (directory, index) => {
      const hookPath = path.join(fsmonitorDirectory, `repository-${index}`);
      await writeFile(
        hookPath,
        [
          '#!/bin/sh',
          `token="${FSMONITOR_TOKEN}"`,
          'scenario="${OPENCHAMBER_GIT_PERF_SCENARIO:-unclassified}"',
          'if [ "$1" = "2" ]; then',
          '  if [ "$scenario" = "mixed-workload" ]; then',
          '    response="refresh"',
          '    printf "%s\\000/\\000" "$token"',
          '  elif [ "$2" = "$token" ]; then',
          '    response="warm"',
          '    printf "%s\\000" "$token"',
          '  else',
          '    response="cold"',
          '    printf "%s\\000/\\000" "$token"',
          '  fi',
          'else',
          '  response="unsupported"',
          '  printf "/\\000"',
          'fi',
          'printf "%s\\t%s\\t%s\\n" "$scenario" "$1" "$response" >> "$OPENCHAMBER_GIT_PERF_FSMONITOR_TRACE"',
          '',
        ].join('\n'),
        'utf8',
      );
      await chmod(hookPath, 0o700);
      await runGit(root, config.realGit, directEnvironment, directory, [
        'config', '--local', 'core.fsmonitor', hookPath,
      ]);
      await runGit(root, config.realGit, directEnvironment, directory, [
        'config', '--local', 'core.fsmonitorHookVersion', '2',
      ]);
      fsmonitorConfigurations[index] = { directory, hookPath };
      return undefined;
    });
  }

  const shimPath = path.join(shimDirectory, 'git');
  await writeFile(
    shimPath,
    [
      '#!/bin/sh',
      'printf "%s\\n" "${OPENCHAMBER_GIT_PERF_SCENARIO:-unclassified}" >> "$OPENCHAMBER_GIT_PERF_TRACE"',
      'exec "$OPENCHAMBER_GIT_PERF_REAL" "$@"',
      '',
    ].join('\n'),
    'utf8',
  );
  await chmod(shimPath, 0o700);
  await writeFile(tracePath, '', 'utf8');
  const measuredEnvironment: NodeJS.ProcessEnv = {
    ...directEnvironment,
    PATH: `${shimDirectory}${path.delimiter}${originalPath}`,
    OPENCHAMBER_GIT_PERF_REAL: config.realGit,
    OPENCHAMBER_GIT_PERF_TRACE: tracePath,
    ...(config.fsmonitorMode === 'fixture-hook-v2'
      ? { OPENCHAMBER_GIT_PERF_FSMONITOR_TRACE: fsmonitorTracePath }
      : {}),
  };
  return {
    root,
    directEnvironment,
    measuredEnvironment,
    tracePath,
    primaryWorktrees,
    linkedWorktrees,
    allWorktrees,
    fsmonitor: {
      mode: config.fsmonitorMode,
      tracePath: fsmonitorTracePath,
      configurations: fsmonitorConfigurations,
    },
  };
};

const replaceProcessEnvironment = (environment: NodeJS.ProcessEnv): void => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) process.env[key] = value;
  }
};

const readLaunchCounts = async (tracePath: string): Promise<Record<string, number>> => {
  const raw = await readFile(tracePath, 'utf8').catch(() => '');
  const counts: Record<string, number> = {};
  for (const line of raw.split(/\r?\n/)) {
    const scenario = line.trim();
    if (!scenario) continue;
    counts[scenario] = (counts[scenario] ?? 0) + 1;
  }
  return counts;
};

const readFsmonitorInvocations = async (tracePath: string): Promise<FsmonitorInvocation[]> => {
  const raw = await readFile(tracePath, 'utf8').catch(() => '');
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [scenario = '', version = '', response = 'malformed'] = line.split('\t');
      return { scenario, version, response };
    });
};

const buildFsmonitorReport = async (
  fixture: Fixture,
  config: WorkerConfig,
  correctness: CorrectnessCollector,
): Promise<GitServiceTargetReport['fsmonitor']> => {
  const invocations = await readFsmonitorInvocations(fixture.fsmonitor.tracePath);
  const invocationCounts = new Map<string, number>();
  for (const invocation of invocations) {
    invocationCounts.set(invocation.scenario, (invocationCounts.get(invocation.scenario) ?? 0) + 1);
  }
  const invocationsByScenario = Object.fromEntries(
    [...invocationCounts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );

  if (fixture.fsmonitor.mode === 'disabled') {
    correctness.check(invocations.length === 0, 'disabled fsmonitor target unexpectedly invoked a hook');
    return {
      mode: 'disabled',
      configurationOwner: 'Git fixture local config',
      configuredCommonDirectories: 0,
      configurationPreserved: null,
      protocolVersion: null,
      invocations: invocations.length,
      invocationsByScenario,
      coldResponses: 0,
      warmResponses: 0,
      refreshResponses: 0,
      unexpectedVersions: [],
      unclassifiedInvocations: 0,
    };
  }

  correctness.check(
    fixture.fsmonitor.configurations.length === config.workload.commonDirectories,
    'fsmonitor configured common-directory count differs',
  );
  let configurationPreserved = true;
  for (const entry of fixture.fsmonitor.configurations) {
    const configuredPath = (await runGit(
      fixture.root,
      config.realGit,
      fixture.directEnvironment,
      entry.directory,
      ['config', '--local', '--get', 'core.fsmonitor'],
    )).trim();
    const configuredVersion = (await runGit(
      fixture.root,
      config.realGit,
      fixture.directEnvironment,
      entry.directory,
      ['config', '--local', '--get', 'core.fsmonitorHookVersion'],
    )).trim();
    const entryPreserved = configuredPath === entry.hookPath && configuredVersion === '2';
    configurationPreserved = configurationPreserved && entryPreserved;
    correctness.check(entryPreserved, 'Git service changed fixture-local fsmonitor configuration');
  }

  const unexpectedVersions = [...new Set(
    invocations.filter((invocation) => invocation.version !== '2').map((invocation) => invocation.version || '<empty>'),
  )].sort();
  const coldResponses = invocations.filter((invocation) => invocation.response === 'cold').length;
  const warmResponses = invocations.filter((invocation) => invocation.response === 'warm').length;
  const refreshResponses = invocations.filter((invocation) => invocation.response === 'refresh').length;
  const unclassifiedInvocations = invocations.filter((invocation) => invocation.scenario === 'unclassified').length;
  correctness.check(invocations.length > 0, 'configured fsmonitor hook was not invoked');
  correctness.check(unexpectedVersions.length === 0, 'configured fsmonitor hook did not use protocol version 2');
  correctness.check(
    (invocationsByScenario['cold-status'] ?? 0) === config.workload.startupCallers,
    'cold status did not invoke fsmonitor exactly once per worktree identity',
  );
  correctness.check(
    (invocationsByScenario['warm-status'] ?? 0) === config.workload.startupCallers,
    'warm status did not invoke fsmonitor exactly once per worktree identity',
  );
  correctness.check(
    coldResponses === config.workload.startupCallers,
    'fsmonitor cold-response count differs from worktree identity count',
  );
  correctness.check(
    warmResponses >= config.workload.startupCallers,
    'fsmonitor did not exercise its warm token response',
  );
  correctness.check(unclassifiedInvocations === 0, 'fsmonitor hook invocation was not assigned to a scenario');

  return {
    mode: 'fixture-hook-v2',
    configurationOwner: 'Git fixture local config',
    configuredCommonDirectories: fixture.fsmonitor.configurations.length,
    configurationPreserved,
    protocolVersion: 2,
    invocations: invocations.length,
    invocationsByScenario,
    coldResponses,
    warmResponses,
    refreshResponses,
    unexpectedVersions,
    unclassifiedInvocations,
  };
};

const sumCounts = (counts: Record<string, number>): number => (
  Object.values(counts).reduce((total, value) => total + value, 0)
);

const loadService = async (servicePath: string): Promise<GitServiceModule> => {
  const module = await import(pathToFileURL(servicePath).href) as Partial<GitServiceModule>;
  if (typeof module.getStatus !== 'function' || typeof module.stageFile !== 'function' || typeof module.fetch !== 'function') {
    throw new Error('Target Git service does not expose getStatus, stageFile, and fetch');
  }
  return module as GitServiceModule;
};

const verifyFixtureTopology = async (
  fixture: Fixture,
  config: WorkerConfig,
  correctness: CorrectnessCollector,
): Promise<void> => {
  const identities = await mapLimit(fixture.allWorktrees, 8, async (directory) => {
    const raw = await runGit(
      fixture.root,
      config.realGit,
      fixture.directEnvironment,
      directory,
      ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'],
    );
    const lines = raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    const commonPath = path.isAbsolute(lines[0] ?? '') ? lines[0]! : path.resolve(directory, lines[0] ?? '');
    const topLevel = path.isAbsolute(lines[1] ?? '') ? lines[1]! : path.resolve(directory, lines[1] ?? '');
    return {
      common: await realpath(commonPath),
      topLevel: await realpath(topLevel),
    };
  });
  correctness.check(fixture.allWorktrees.length === config.workload.worktreeIdentities, 'fixture worktree count differs');
  correctness.check(
    new Set(identities.map((identity) => identity.common)).size === config.workload.commonDirectories,
    'fixture common-directory count differs',
  );
  correctness.check(
    new Set(identities.map((identity) => identity.topLevel)).size === config.workload.worktreeIdentities,
    'fixture top-level identity count differs',
  );
  for (let index = 0; index < fixture.linkedWorktrees.length; index += 1) {
    const primaryIdentity = identities[index % fixture.primaryWorktrees.length];
    const linkedIdentity = identities[fixture.primaryWorktrees.length + index];
    correctness.check(
      primaryIdentity?.common === linkedIdentity?.common && primaryIdentity?.topLevel !== linkedIdentity?.topLevel,
      `fixture linked worktree ${index} does not share only its owner's common directory`,
    );
  }
};

const timeCall = async <T>(latencies: number[], task: () => Promise<T>): Promise<T> => {
  const startedAt = performance.now();
  try {
    return await task();
  } finally {
    latencies.push(performance.now() - startedAt);
  }
};

const runStatusScenario = async (
  scenarioName: string,
  service: GitServiceModule,
  fixture: Fixture,
  indices: number[],
  latencies: number[],
  correctness: CorrectnessCollector,
  batchSize = indices.length,
): Promise<ScenarioReport> => {
  process.env.OPENCHAMBER_GIT_PERF_SCENARIO = scenarioName;
  const beforeCounts = await readLaunchCounts(fixture.tracePath);
  const startedAt = performance.now();
  const effectiveBatchSize = Math.max(1, batchSize);
  for (let offset = 0; offset < indices.length; offset += effectiveBatchSize) {
    const batch = indices.slice(offset, offset + effectiveBatchSize);
    await Promise.all(batch.map(async (worktreeIndex) => {
      const directory = fixture.allWorktrees[worktreeIndex]!;
      const identityPath = `identity-${worktreeIndex}.txt`;
      try {
        const result = await timeCall(latencies, () => service.getStatus(directory, { mode: 'light' }));
        const paths = new Set((result.files ?? []).map((file) => String(file.path ?? '')));
        correctness.check(paths.has(identityPath), `${scenarioName}: status omitted requested worktree identity ${worktreeIndex}`);
        correctness.check(result.isClean === false, `${scenarioName}: dirty worktree ${worktreeIndex} was reported clean`);
      } catch (error) {
        correctness.fail(`${scenarioName}: status ${worktreeIndex} failed: ${error instanceof Error ? error.name : 'Error'}`);
      }
    }));
  }
  const durationMs = performance.now() - startedAt;
  const afterCounts = await readLaunchCounts(fixture.tracePath);
  delete process.env.OPENCHAMBER_GIT_PERF_SCENARIO;
  return {
    logicalCallers: indices.length,
    durationMs: round(durationMs),
    gitLaunches: (afterCounts[scenarioName] ?? 0) - (beforeCounts[scenarioName] ?? 0),
  };
};

const runMixedScenario = async (
  service: GitServiceModule,
  fixture: Fixture,
  config: WorkerConfig,
  mutationLatencies: number[],
  fetchLatencies: number[],
  correctness: CorrectnessCollector,
): Promise<ScenarioReport> => {
  type MixedSpec = { type: 'mutation'; index: number } | { type: 'fetch'; index: number };
  const mutationPathsByWorktree = new Map<number, string[]>();
  await Promise.all(Array.from({ length: config.workload.mutations }, async (_, index) => {
    const worktreeIndex = index % fixture.allWorktrees.length;
    const relativePath = `mutation-${index}.txt`;
    const paths = mutationPathsByWorktree.get(worktreeIndex) ?? [];
    paths.push(relativePath);
    mutationPathsByWorktree.set(worktreeIndex, paths);
    await writeFile(path.join(fixture.allWorktrees[worktreeIndex]!, relativePath), `mutation ${index}\n`, 'utf8');
  }));
  const random = new SeededRandom(config.seed);
  const plan = random.shuffle<MixedSpec>([
    ...Array.from({ length: config.workload.mutations }, (_, index): MixedSpec => ({ type: 'mutation', index })),
    ...Array.from({ length: config.workload.fetches }, (_, index): MixedSpec => ({ type: 'fetch', index })),
  ]);
  const scenarioName = 'mixed-workload';
  process.env.OPENCHAMBER_GIT_PERF_SCENARIO = scenarioName;
  const beforeCounts = await readLaunchCounts(fixture.tracePath);
  const startedAt = performance.now();
  await Promise.all(plan.map(async (spec) => {
    if (spec.type === 'fetch') {
      const directory = fixture.primaryWorktrees[spec.index % fixture.primaryWorktrees.length]!;
      try {
        const result = await timeCall(fetchLatencies, () => service.fetch(directory, { remote: 'origin' }));
        correctness.check(result?.success === true, `mixed-workload: fetch ${spec.index} did not report success`);
      } catch (error) {
        correctness.fail(`mixed-workload: fetch ${spec.index} failed: ${error instanceof Error ? error.name : 'Error'}`);
      }
      return;
    }
    const worktreeIndex = spec.index % fixture.allWorktrees.length;
    const relativePath = `mutation-${spec.index}.txt`;
    try {
      await timeCall(mutationLatencies, () => service.stageFile(fixture.allWorktrees[worktreeIndex]!, relativePath));
    } catch (error) {
      correctness.fail(`mixed-workload: mutation ${spec.index} failed: ${error instanceof Error ? error.name : 'Error'}`);
    }
  }));
  const durationMs = performance.now() - startedAt;
  const afterCounts = await readLaunchCounts(fixture.tracePath);
  delete process.env.OPENCHAMBER_GIT_PERF_SCENARIO;

  await mapLimit(fixture.allWorktrees, 8, async (directory, worktreeIndex) => {
    const raw = await runGit(
      fixture.root,
      config.realGit,
      fixture.directEnvironment,
      directory,
      ['diff', '--cached', '--name-only'],
    );
    const actual = raw.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).sort();
    const expected = [...(mutationPathsByWorktree.get(worktreeIndex) ?? [])].sort();
    correctness.check(
      JSON.stringify(actual) === JSON.stringify(expected),
      `mixed-workload: staged paths differ for worktree ${worktreeIndex}`,
    );
    return undefined;
  });

  return {
    logicalCallers: plan.length,
    durationMs: round(durationMs),
    gitLaunches: (afterCounts[scenarioName] ?? 0) - (beforeCounts[scenarioName] ?? 0),
  };
};

const failedTargetReport = (
  config: WorkerConfig,
  error: unknown,
  cleanupSucceeded: boolean,
): GitServiceTargetReport => ({
  label: config.label,
  passed: false,
  profile: config.profile,
  sourceHash: config.sourceHash,
  durationMs: 0,
  throughputCallsPerSecond: 0,
  cardinality: {
    sessionEntities: config.workload.sessionRecords,
    uniqueCommonDirectories: config.workload.commonDirectories,
    uniqueWorktreeIdentities: config.workload.worktreeIdentities,
    serviceCalls: (config.workload.startupCallers * 2)
      + config.workload.fanoutCallers
      + config.workload.mutations
      + config.workload.fetches,
  },
  scenarios: {
    entityMapping: { logicalCallers: config.workload.sessionRecords, durationMs: 0, gitLaunches: 0 },
    coldStatus: { logicalCallers: config.workload.startupCallers, durationMs: 0, gitLaunches: 0 },
    warmStatus: { logicalCallers: config.workload.startupCallers, durationMs: 0, gitLaunches: 0 },
    pathologicalFanout: config.workload.fanoutCallers > 0
      ? { logicalCallers: config.workload.fanoutCallers, durationMs: 0, gitLaunches: 0 }
      : null,
    mixedWorkload: {
      logicalCallers: config.workload.mutations + config.workload.fetches,
      durationMs: 0,
      gitLaunches: 0,
    },
  },
  latencyMs: {
    coldStatus: distribution([]),
    warmStatus: distribution([]),
    pathologicalFanoutStatus: config.workload.fanoutCallers > 0 ? distribution([]) : null,
    mutation: distribution([]),
    fetch: distribution([]),
  },
  gitProcesses: {
    scope: 'top-level service-started git executable launches',
    instrumentation: 'POSIX PATH shim logs once and execs the real Git binary',
    totalLaunches: 0,
    unclassifiedLaunches: 0,
  },
  resources: {
    scope: 'benchmark worker process; child Git CPU is excluded',
    cpuUserMicros: 0,
    cpuSystemMicros: 0,
    rssStartBytes: 0,
    rssEndBytes: 0,
    heapStartBytes: 0,
    heapEndBytes: 0,
  },
  fsmonitor: {
    mode: config.fsmonitorMode,
    configurationOwner: 'Git fixture local config',
    configuredCommonDirectories: 0,
    configurationPreserved: config.fsmonitorMode === 'fixture-hook-v2' ? false : null,
    protocolVersion: config.fsmonitorMode === 'fixture-hook-v2' ? 2 : null,
    invocations: 0,
    invocationsByScenario: {},
    coldResponses: 0,
    warmResponses: 0,
    refreshResponses: 0,
    unexpectedVersions: [],
    unclassifiedInvocations: 0,
  },
  correctness: { checks: 0, failures: 1, failureSamples: ['worker did not complete'] },
  cleanupSucceeded,
  operationalError: describeError(error, [
    [config.fixtureRoot, '<fixture>'],
    [WORKSPACE_ROOT, '<workspace>'],
    [path.dirname(config.servicePath), '<service-root>'],
  ]),
});

const runWorker = async (config: WorkerConfig): Promise<GitServiceTargetReport> => {
  let fixture: Fixture | null = null;
  let report: GitServiceTargetReport | null = null;
  let operationalError: unknown = null;
  let cleanupSucceeded = false;
  try {
    fixture = await createFixture(config);
    replaceProcessEnvironment(fixture.measuredEnvironment);
    const service = await loadService(config.servicePath);
    const correctness = new CorrectnessCollector();
    await verifyFixtureTopology(fixture, config, correctness);
    const coldLatencies: number[] = [];
    const warmLatencies: number[] = [];
    const fanoutLatencies: number[] = [];
    const mutationLatencies: number[] = [];
    const fetchLatencies: number[] = [];
    const cpuStart = process.resourceUsage();
    const memoryStart = process.memoryUsage();
    const mappingLaunchesBefore = sumCounts(await readLaunchCounts(fixture.tracePath));
    const mappingStartedAt = performance.now();
    const sessions = Array.from({ length: config.workload.sessionRecords }, (_, index) => ({
      id: `session-${index}`,
      directory: fixture!.allWorktrees[index % fixture!.allWorktrees.length]!,
    }));
    const uniqueSessionWorktrees = new Set(sessions.map((session) => session.directory));
    const mappingDurationMs = performance.now() - mappingStartedAt;
    const mappingLaunchesAfter = sumCounts(await readLaunchCounts(fixture.tracePath));
    correctness.check(sessions.length === config.workload.sessionRecords, 'entity mapping session count differs');
    correctness.check(uniqueSessionWorktrees.size === config.workload.worktreeIdentities, 'entity mapping worktree count differs');
    correctness.check(mappingLaunchesAfter === mappingLaunchesBefore, 'entity mapping started Git');

    const statusIndices = Array.from({ length: fixture.allWorktrees.length }, (_, index) => index);
    const coldStatus = await runStatusScenario(
      'cold-status',
      service,
      fixture,
      statusIndices,
      coldLatencies,
      correctness,
    );
    const warmStatus = await runStatusScenario(
      'warm-status',
      service,
      fixture,
      statusIndices,
      warmLatencies,
      correctness,
    );

    let pathologicalFanout: ScenarioReport | null = null;
    if (config.workload.fanoutCallers > 0) {
      const callersPerIdentity = config.workload.fanoutCallers / fixture.allWorktrees.length;
      correctness.check(
        Number.isInteger(callersPerIdentity),
        'pathological fan-out callers must divide evenly across worktree identities',
      );
      const fanoutIndices = fixture.allWorktrees.flatMap((_, worktreeIndex) => (
        Array.from({ length: callersPerIdentity }, () => worktreeIndex)
      ));
      pathologicalFanout = await runStatusScenario(
        'pathological-fanout-status',
        service,
        fixture,
        fanoutIndices,
        fanoutLatencies,
        correctness,
        config.workload.fanoutBatchSize,
      );
    }

    const mixedWorkload = await runMixedScenario(
      service,
      fixture,
      config,
      mutationLatencies,
      fetchLatencies,
      correctness,
    );
    const durationMs = mappingDurationMs
      + coldStatus.durationMs
      + warmStatus.durationMs
      + (pathologicalFanout?.durationMs ?? 0)
      + mixedWorkload.durationMs;
    const cpuEnd = process.resourceUsage();
    const memoryEnd = process.memoryUsage();
    const launchCounts = await readLaunchCounts(fixture.tracePath);
    const totalServiceCalls = coldStatus.logicalCallers
      + warmStatus.logicalCallers
      + (pathologicalFanout?.logicalCallers ?? 0)
      + mixedWorkload.logicalCallers;
    const fsmonitor = await buildFsmonitorReport(fixture, config, correctness);
    const correctnessReport = correctness.report();
    report = {
      label: config.label,
      passed: correctnessReport.failures === 0 && (launchCounts.unclassified ?? 0) === 0,
      profile: config.profile,
      sourceHash: config.sourceHash,
      durationMs: round(durationMs),
      throughputCallsPerSecond: durationMs === 0 ? 0 : round((totalServiceCalls / durationMs) * 1_000),
      cardinality: {
        sessionEntities: sessions.length,
        uniqueCommonDirectories: fixture.primaryWorktrees.length,
        uniqueWorktreeIdentities: uniqueSessionWorktrees.size,
        serviceCalls: totalServiceCalls,
      },
      scenarios: {
        entityMapping: {
          logicalCallers: sessions.length,
          durationMs: round(mappingDurationMs),
          gitLaunches: mappingLaunchesAfter - mappingLaunchesBefore,
        },
        coldStatus,
        warmStatus,
        pathologicalFanout,
        mixedWorkload,
      },
      latencyMs: {
        coldStatus: distribution(coldLatencies),
        warmStatus: distribution(warmLatencies),
        pathologicalFanoutStatus: pathologicalFanout ? distribution(fanoutLatencies) : null,
        mutation: distribution(mutationLatencies),
        fetch: distribution(fetchLatencies),
      },
      gitProcesses: {
        scope: 'top-level service-started git executable launches',
        instrumentation: 'POSIX PATH shim logs once and execs the real Git binary',
        totalLaunches: sumCounts(launchCounts),
        unclassifiedLaunches: launchCounts.unclassified ?? 0,
      },
      resources: {
        scope: 'benchmark worker process; child Git CPU is excluded',
        cpuUserMicros: cpuEnd.userCPUTime - cpuStart.userCPUTime,
        cpuSystemMicros: cpuEnd.systemCPUTime - cpuStart.systemCPUTime,
        rssStartBytes: memoryStart.rss,
        rssEndBytes: memoryEnd.rss,
        heapStartBytes: memoryStart.heapUsed,
        heapEndBytes: memoryEnd.heapUsed,
      },
      fsmonitor,
      correctness: correctnessReport,
      cleanupSucceeded: false,
      operationalError: null,
    };
  } catch (error) {
    operationalError = error;
  } finally {
    await rm(config.fixtureRoot, { recursive: true, force: true })
      .then(() => { cleanupSucceeded = true; })
      .catch(() => { cleanupSucceeded = false; });
  }

  if (!report) return failedTargetReport(config, operationalError, cleanupSucceeded);
  report.cleanupSucceeded = cleanupSucceeded;
  report.passed = report.passed && cleanupSucceeded;
  if (!cleanupSucceeded) {
    report.operationalError = { name: 'CleanupError', message: 'fixture cleanup failed' };
  }
  return report;
};

const runGitRepositoryCommand = async (realGit: string, args: string[]): Promise<string> => {
  const result = await runProcess(realGit, args, {
    cwd: WORKSPACE_ROOT,
    env: createRepositoryGitEnvironment(),
    timeoutMs: 60_000,
  });
  if (result.timedOut || result.exitCode !== 0) {
    throw new Error(`Repository Git command failed: git ${args[0] ?? ''}`);
  }
  return result.stdout.trim();
};

const verifyAndMaterializeBaseline = async (
  comparisonRoot: string,
  realGit: string,
  baselineRef: string,
): Promise<{
  servicePath: string;
  sourceHash: string;
  resolvedRef: string;
  architectureCommit: string;
  verifiedDirectParent: boolean;
}> => {
  if (!/^[0-9a-f]{7,40}$/i.test(baselineRef)) throw new Error('--baseline-ref must be a hexadecimal commit ID');
  const resolvedRef = await runGitRepositoryCommand(realGit, ['rev-parse', `${baselineRef}^{commit}`]);
  const architectureCommit = await runGitRepositoryCommand(realGit, ['rev-parse', `${ARCHITECTURE_COMMIT}^{commit}`]);
  const architectureParent = await runGitRepositoryCommand(realGit, ['rev-parse', `${architectureCommit}^`]);
  const verifiedDirectParent = architectureParent === resolvedRef;
  if (!verifiedDirectParent) throw new Error('Baseline must be the direct parent of the Git execution architecture commit');
  const source = await runGitRepositoryCommand(realGit, [
    'show', `${resolvedRef}:${HISTORICAL_SERVICE_REPOSITORY_PATH}`,
  ]);
  if (/\bfrom\s+['"]\./.test(source) || /\bimport\s*\(\s*['"]\./.test(source)) {
    throw new Error('Historical service unexpectedly imports repository-local modules');
  }
  const baselineRoot = path.join(comparisonRoot, 'baseline-source');
  await mkdir(baselineRoot, { recursive: true });
  const servicePath = path.join(baselineRoot, 'service.js');
  await writeFile(servicePath, source, 'utf8');
  await writeFile(path.join(baselineRoot, 'package.json'), '{"type":"module","private":true}\n', 'utf8');
  const nodeModules = path.join(WORKSPACE_ROOT, 'node_modules');
  if (!existsSync(nodeModules)) throw new Error('Current node_modules is required for the controlled dependency comparison');
  await symlink(nodeModules, path.join(baselineRoot, 'node_modules'), 'dir');
  return {
    servicePath,
    sourceHash: hashSource(source),
    resolvedRef,
    architectureCommit,
    verifiedDirectParent,
  };
};

const workerTimeoutForProfile = (profile: GitServiceComparisonProfile): number => {
  if (profile === 'smoke') return 120_000;
  if (profile === 'target') return 20 * 60_000;
  return 30 * 60_000;
};

const runWorkerChild = async (config: WorkerConfig, comparisonRoot: string): Promise<GitServiceTargetReport> => {
  const configPath = path.join(comparisonRoot, `worker-${config.label}.json`);
  await writeFile(configPath, JSON.stringify(config), 'utf8');
  const result = await runProcess(process.execPath, [SCRIPT_PATH, '--worker-config', configPath], {
    cwd: WORKSPACE_ROOT,
    env: createWorkerEnvironment(),
    timeoutMs: workerTimeoutForProfile(config.profile),
    detached: process.platform !== 'win32',
  });
  try {
    const parsed = JSON.parse(result.stdout) as GitServiceTargetReport;
    if (result.timedOut) {
      parsed.passed = false;
      parsed.operationalError = { name: 'WorkerTimeoutError', message: 'comparison worker exceeded its profile timeout' };
    }
    return parsed;
  } catch {
    const reason = result.timedOut
      ? new Error('comparison worker exceeded its profile timeout')
      : new Error(`comparison worker exited ${result.exitCode}`);
    return failedTargetReport(config, reason, false);
  }
};

const buildMetricComparison = (
  baseline: GitServiceTargetReport,
  candidate: GitServiceTargetReport,
): GitServiceComparisonReport['comparison']['beforeToAfter'] => ({
  workloadDurationMs: delta(baseline.durationMs, candidate.durationMs),
  workloadGitLaunches: delta(baseline.gitProcesses.totalLaunches, candidate.gitProcesses.totalLaunches),
  coldStatusP95Ms: delta(baseline.latencyMs.coldStatus.p95, candidate.latencyMs.coldStatus.p95),
  warmStatusP95Ms: delta(baseline.latencyMs.warmStatus.p95, candidate.latencyMs.warmStatus.p95),
  mutationP95Ms: delta(baseline.latencyMs.mutation.p95, candidate.latencyMs.mutation.p95),
  fetchP95Ms: delta(baseline.latencyMs.fetch.p95, candidate.latencyMs.fetch.p95),
  pathologicalFanoutP95Ms: baseline.latencyMs.pathologicalFanoutStatus
    && candidate.latencyMs.pathologicalFanoutStatus
    ? delta(baseline.latencyMs.pathologicalFanoutStatus.p95, candidate.latencyMs.pathologicalFanoutStatus.p95)
    : null,
});

const buildComparison = (
  before: GitServiceTargetReport,
  after: GitServiceTargetReport,
  afterFsmonitor: GitServiceTargetReport,
): GitServiceComparisonReport['comparison'] => {
  const cardinalities = [before, after, afterFsmonitor].map((target) => JSON.stringify(target.cardinality));
  const valid = before.passed && after.passed && afterFsmonitor.passed
    && new Set(cardinalities).size === 1
    && after.sourceHash === afterFsmonitor.sourceHash
    && before.fsmonitor.mode === 'disabled'
    && after.fsmonitor.mode === 'disabled'
    && afterFsmonitor.fsmonitor.mode === 'fixture-hook-v2';
  return {
    valid,
    beforeToAfter: buildMetricComparison(before, after),
    afterToAfterFsmonitor: buildMetricComparison(after, afterFsmonitor),
    interpretation: [
      'Correctness, equal cardinality, identical current source hashes, hook invocation, and preserved Git config are required before timing or launch deltas are valid.',
      'Cold and warm status are measured for all three targets; only after-fsmonitor has a fixture-local Git fsmonitor hook.',
      'The version-2 fixture hook reports all paths for an unknown token or the mutation scenario and no paths for its unchanged warm token; Git owns invocation and index state.',
      'Latency includes the same lightweight POSIX launch-count shim in all implementations and remains machine-specific.',
      'Reported workload duration is the sum of measured service scenarios; fixture setup and direct correctness-oracle time are excluded.',
      'Git launch counts cover top-level service-started git executables; Git helpers and fixture/oracle commands are excluded.',
      'All service targets use the current installed dependency tree, isolating source architecture and fsmonitor configuration rather than historical dependency drift.',
      'OpenChamber does not read, write, probe, cache, or manage production core.fsmonitor configuration or daemon lifecycle.',
      'The representative target maps 30,000 entities to 300 identities; only the explicit pathological profile submits 30,000 status callers.',
      'The comparative pathological profile submits those callers in reviewed 600-caller waves to avoid an unsafe 30,000-process legacy burst; it is not the current-only simultaneous fan-out guard.',
    ],
  };
};

const runComparisonWithTargets = async (options: {
  profile: GitServiceComparisonProfile;
  seed: number;
  baselineRef: string;
  beforeTarget?: { servicePath: string; sourceHash: string; label: GitServiceTargetReport['label'] };
  afterTarget?: { servicePath: string; sourceHash: string; label: GitServiceTargetReport['label'] };
  afterFsmonitorTarget?: { servicePath: string; sourceHash: string; label: GitServiceTargetReport['label'] };
  order?: 'before-first' | 'after-first';
}): Promise<GitServiceComparisonReport> => {
  const realGit = await resolveExecutable('git');
  const comparisonRoot = await mkdtemp(path.join(tmpdir(), 'openchamber-git-service-comparison-'));
  try {
    const workload = workloadForProfile(options.profile);
    const baseline = options.beforeTarget
      ? {
        servicePath: options.beforeTarget.servicePath,
        sourceHash: options.beforeTarget.sourceHash,
        resolvedRef: 'programmatic-control',
        architectureCommit: ARCHITECTURE_COMMIT,
        verifiedDirectParent: true,
      }
      : await verifyAndMaterializeBaseline(comparisonRoot, realGit, options.baselineRef);
    const currentSource = await readFile(CURRENT_SERVICE_PATH, 'utf8');
    const beforeTarget = options.beforeTarget ?? {
      servicePath: baseline.servicePath,
      sourceHash: baseline.sourceHash,
      label: 'before' as const,
    };
    const afterTarget = options.afterTarget ?? {
      servicePath: CURRENT_SERVICE_PATH,
      sourceHash: hashSource(currentSource),
      label: 'after' as const,
    };
    const afterFsmonitorTarget = options.afterFsmonitorTarget ?? {
      servicePath: CURRENT_SERVICE_PATH,
      sourceHash: hashSource(currentSource),
      label: 'after-fsmonitor' as const,
    };
    const beforeConfig: WorkerConfig = {
      label: beforeTarget.label,
      profile: options.profile,
      workload,
      seed: options.seed,
      servicePath: beforeTarget.servicePath,
      sourceHash: beforeTarget.sourceHash,
      comparisonRoot,
      fixtureRoot: path.join(comparisonRoot, 'before-fixture'),
      realGit,
      fsmonitorMode: 'disabled',
    };
    const afterConfig: WorkerConfig = {
      label: afterTarget.label,
      profile: options.profile,
      workload,
      seed: options.seed,
      servicePath: afterTarget.servicePath,
      sourceHash: afterTarget.sourceHash,
      comparisonRoot,
      fixtureRoot: path.join(comparisonRoot, 'after-fixture'),
      realGit,
      fsmonitorMode: 'disabled',
    };
    const afterFsmonitorConfig: WorkerConfig = {
      label: afterFsmonitorTarget.label,
      profile: options.profile,
      workload,
      seed: options.seed,
      servicePath: afterFsmonitorTarget.servicePath,
      sourceHash: afterFsmonitorTarget.sourceHash,
      comparisonRoot,
      fixtureRoot: path.join(comparisonRoot, 'after-fsmonitor-fixture'),
      realGit,
      fsmonitorMode: 'fixture-hook-v2',
    };
    let before: GitServiceTargetReport;
    let after: GitServiceTargetReport;
    let afterFsmonitor: GitServiceTargetReport;
    if (options.order === 'after-first') {
      afterFsmonitor = await runWorkerChild(afterFsmonitorConfig, comparisonRoot);
      after = await runWorkerChild(afterConfig, comparisonRoot);
      before = await runWorkerChild(beforeConfig, comparisonRoot);
    } else {
      before = await runWorkerChild(beforeConfig, comparisonRoot);
      after = await runWorkerChild(afterConfig, comparisonRoot);
      afterFsmonitor = await runWorkerChild(afterFsmonitorConfig, comparisonRoot);
    }
    const comparison = buildComparison(before, after, afterFsmonitor);
    const gitVersionResult = await runProcess(realGit, ['--version'], {
      cwd: WORKSPACE_ROOT,
      env: process.env,
      timeoutMs: 10_000,
    });
    return {
      schemaVersion: 2,
      passed: comparison.valid,
      profile: options.profile,
      seed: options.seed,
      baseline: {
        requestedRef: options.baselineRef,
        resolvedRef: baseline.resolvedRef,
        architectureCommit: baseline.architectureCommit,
        verifiedDirectParent: baseline.verifiedDirectParent,
      },
      environment: {
        platform: process.platform,
        architecture: process.arch,
        gitVersion: gitVersionResult.stdout.trim(),
        bunVersion: process.versions.bun ?? null,
        nodeVersion: process.versions.node,
        dependencyPolicy: 'same current installed dependency tree for before, after, and after-fsmonitor',
        runOrder: options.order === 'after-first'
          ? ['after-fsmonitor', 'after', 'before']
          : ['before', 'after', 'after-fsmonitor'],
      },
      config: workload,
      before,
      after,
      afterFsmonitor,
      comparison,
    };
  } finally {
    await rm(comparisonRoot, { recursive: true, force: true }).catch(() => undefined);
  }
};

export const inspectGitServiceComparisonProfile = (
  profile: GitServiceComparisonProfile,
): WorkloadConfig => workloadForProfile(profile);

export const runFocusedGitServiceComparison = async (): Promise<GitServiceComparisonReport> => {
  const currentSource = await readFile(CURRENT_SERVICE_PATH, 'utf8');
  const sourceHash = hashSource(currentSource);
  return runComparisonWithTargets({
    profile: 'smoke',
    seed: DEFAULT_SEED,
    baselineRef: DEFAULT_BASELINE_REF,
    order: 'before-first',
    beforeTarget: { servicePath: CURRENT_SERVICE_PATH, sourceHash, label: 'control-before' },
    afterTarget: { servicePath: CURRENT_SERVICE_PATH, sourceHash, label: 'control-after' },
    afterFsmonitorTarget: {
      servicePath: CURRENT_SERVICE_PATH,
      sourceHash,
      label: 'control-after-fsmonitor',
    },
  });
};

const parsePositiveInteger = (value: string | undefined, flag: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} requires a positive integer`);
  return parsed;
};

export const parseGitServiceComparisonCliArgs = (args: string[]): CliOptions => {
  const options: CliOptions = {
    profile: 'smoke',
    baselineRef: DEFAULT_BASELINE_REF,
    seed: DEFAULT_SEED,
    allowPathological: false,
    order: 'before-first',
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--profile') {
      const value = args[++index];
      if (value !== 'smoke' && value !== 'target' && value !== 'pathological-fanout') {
        throw new Error('--profile must be smoke, target, or pathological-fanout');
      }
      options.profile = value;
      continue;
    }
    if (flag === '--baseline-ref') {
      const value = args[++index];
      if (!value) throw new Error('--baseline-ref requires a value');
      options.baselineRef = value;
      continue;
    }
    if (flag === '--seed') {
      options.seed = parsePositiveInteger(args[++index], '--seed');
      continue;
    }
    if (flag === '--output') {
      const value = args[++index];
      if (!value) throw new Error('--output requires a path');
      options.output = value;
      continue;
    }
    if (flag === '--allow-pathological') {
      options.allowPathological = true;
      continue;
    }
    if (flag === '--order') {
      const value = args[++index];
      if (value !== 'before-first' && value !== 'after-first') {
        throw new Error('--order must be before-first or after-first');
      }
      options.order = value;
      continue;
    }
    if (flag === '--worker-config') {
      const value = args[++index];
      if (!value) throw new Error('--worker-config requires a path');
      options.workerConfig = value;
      continue;
    }
    throw new Error(`Unknown argument: ${flag}`);
  }
  if (options.profile === 'pathological-fanout' && !options.allowPathological && !options.workerConfig) {
    throw new Error('pathological-fanout requires explicit --allow-pathological');
  }
  if (!options.workerConfig && !/^[0-9a-f]{7,40}$/i.test(options.baselineRef)) {
    throw new Error('--baseline-ref must be a hexadecimal commit ID');
  }
  return options;
};

const resolveOutputPath = async (output: string): Promise<string> => {
  const requested = path.resolve(output);
  if (existsSync(requested)) throw new Error('--output must name a new file');
  const workspace = await realpath(WORKSPACE_ROOT);
  const parent = await realpath(path.dirname(requested));
  const canonical = path.join(parent, path.basename(requested));
  if (isWithin(workspace, canonical)) throw new Error('--output must be outside the workspace');
  return canonical;
};

const validateWorkerConfig = async (config: WorkerConfig, configPath: string): Promise<void> => {
  if (!['smoke', 'target', 'pathological-fanout'].includes(config.profile)) {
    throw new Error('worker profile is invalid');
  }
  if (![
    'before',
    'after',
    'after-fsmonitor',
    'control-before',
    'control-after',
    'control-after-fsmonitor',
  ].includes(config.label)) {
    throw new Error('worker label is invalid');
  }
  let expectedFixtureName = 'after-fixture';
  if (config.label.includes('after-fsmonitor')) expectedFixtureName = 'after-fsmonitor-fixture';
  else if (config.label.includes('before')) expectedFixtureName = 'before-fixture';
  const expectedFsmonitorMode = config.label.includes('after-fsmonitor')
    ? 'fixture-hook-v2'
    : 'disabled';
  if (config.fsmonitorMode !== expectedFsmonitorMode) {
    throw new Error('worker fsmonitor mode does not match its target label');
  }
  const temporaryRoot = await realpath(tmpdir());
  const comparisonRoot = await realpath(config.comparisonRoot);
  if (
    path.dirname(comparisonRoot) !== temporaryRoot
    || !path.basename(comparisonRoot).startsWith('openchamber-git-service-comparison-')
  ) {
    throw new Error('worker comparison root is outside the approved temporary boundary');
  }
  const canonicalConfigPath = path.join(await realpath(path.dirname(configPath)), path.basename(configPath));
  if (!isWithin(comparisonRoot, canonicalConfigPath)) {
    throw new Error('worker config is outside its comparison root');
  }
  const fixtureRoot = path.resolve(config.fixtureRoot);
  if (
    path.dirname(fixtureRoot) !== comparisonRoot
    || path.basename(fixtureRoot) !== expectedFixtureName
    || existsSync(fixtureRoot)
  ) {
    throw new Error('worker fixture root is not a new approved child of its comparison root');
  }
  const currentService = await realpath(CURRENT_SERVICE_PATH);
  const targetService = await realpath(config.servicePath);
  if (targetService !== currentService && !isWithin(comparisonRoot, targetService)) {
    throw new Error('worker service source is outside the approved current/baseline boundary');
  }
  if (config.fsmonitorMode === 'fixture-hook-v2' && targetService !== currentService) {
    throw new Error('fsmonitor comparison is restricted to the current Git service');
  }
  if (!/^[0-9a-f]{64}$/i.test(config.sourceHash)) throw new Error('worker source hash is invalid');
  if (hashSource(await readFile(targetService, 'utf8')) !== config.sourceHash) {
    throw new Error('worker service source does not match its declared hash');
  }
  if (!Number.isSafeInteger(config.seed) || config.seed <= 0) throw new Error('worker seed is invalid');
  if (JSON.stringify(config.workload) !== JSON.stringify(workloadForProfile(config.profile))) {
    throw new Error('worker workload differs from its reviewed profile');
  }
  await access(config.realGit, fsConstants.X_OK);
};

const runCli = async (): Promise<void> => {
  const options = parseGitServiceComparisonCliArgs(process.argv.slice(2));
  if (options.workerConfig) {
    const config = JSON.parse(await readFile(options.workerConfig, 'utf8')) as WorkerConfig;
    await validateWorkerConfig(config, options.workerConfig);
    const report = await runWorker(config);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  const outputPath = options.output ? await resolveOutputPath(options.output) : null;
  const report = await runComparisonWithTargets({
    profile: options.profile,
    seed: options.seed,
    baselineRef: options.baselineRef,
    order: options.order,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, json, { encoding: 'utf8', flag: 'wx' });
  else process.stdout.write(json);
  if (!report.passed) process.exitCode = 1;
};

if (import.meta.main) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
