import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  inspectGitExecutionSoakPlan,
  parseGitExecutionCliArgs,
  PROFILE_DEFAULTS,
  runCoordinatorParityAssertions,
  runFocusedGitExecutionProfile,
} from './git-execution.ts';
import type { GitExecutionSoakPlanSummary } from './git-execution.ts';

const runHarnessCli = async (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => (
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts/perf/git-execution.ts'), ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({
      exitCode: exitCode ?? -1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  })
);

test('pr-real exercises the production coordinator with disposable local Git', { timeout: 45_000 }, async () => {
  const inheritedGitEnvironment = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_OPTIONAL_LOCKS: process.env.GIT_OPTIONAL_LOCKS,
    GIT_ASKPASS: process.env.GIT_ASKPASS,
    GCM_ASKPASS: process.env.GCM_ASKPASS,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    SSH_AGENT_PID: process.env.SSH_AGENT_PID,
  };
  process.env.GIT_DIR = path.join(tmpdir(), 'must-not-be-used-by-openchamber-perf');
  process.env.GIT_OPTIONAL_LOCKS = '0';
  process.env.GIT_ASKPASS = 'must-not-run';
  process.env.GCM_ASKPASS = 'must-not-run';
  process.env.SSH_AUTH_SOCK = 'must-not-use';
  process.env.SSH_AGENT_PID = '999999';
  let report: Awaited<ReturnType<typeof runFocusedGitExecutionProfile>>;
  try {
    report = await runFocusedGitExecutionProfile({ profile: 'pr-real', seed: PROFILE_DEFAULTS.seed });
  } finally {
    for (const [key, value] of Object.entries(inheritedGitEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  if (!report.passed) {
    console.error(JSON.stringify(report.assertions.filter((assertion) => !assertion.passed), null, 2));
  }
  assert.equal(report.passed, true);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.profile, 'pr-real');
  assert.equal(report.config.gitChildTimeoutMs, PROFILE_DEFAULTS.gitChildTimeoutMs);
  assert.equal(report.cardinality.sessionEntities, PROFILE_DEFAULTS.prReal.sessionRecords);
  assert.equal('logicalSessions' in report.cardinality, false);
  assert.equal('logicalCallers' in report.cardinality, false);
  assert.equal(report.cardinality.uniqueCommonDirectories, 1);
  assert.equal(report.cardinality.uniqueWorktreeIdentities, 2);
  assert.deepEqual(report.cardinality.entityMapping, {
    applicable: true,
    sessionEntities: 30,
    worktreeIdentities: 2,
    coordinatorApiSubmissions: 0,
    underlyingScheduledOperations: 0,
    gitCommands: 0,
  });
  assert.deepEqual(report.cardinality.scenarios.startup, {
    logicalCallers: 2,
    coordinatorApiSubmissions: 2,
    underlyingScheduledOperations: 2,
    gitCommands: 2,
  });
  assert.deepEqual(report.cardinality.scenarios.fairness, {
    logicalCallers: 3,
    coordinatorApiSubmissions: 3,
    underlyingScheduledOperations: 3,
    gitCommands: 3,
  });
  assert.equal(report.cardinality.coordinatorApiSubmissions, 8);
  assert.equal(report.cardinality.underlyingScheduledOperations, 8);
  assert.equal(report.cardinality.gitCommands, 31);
  assert.equal(report.lifecycle.lockFailures, 1);
  assert.equal(report.lifecycle.lockRetries, 1);
  assert.equal(report.lifecycle.unexpectedErrors, 0);
  assert.equal(report.lifecycle.generationTotal, 8);
  assert.equal(report.lifecycle.expectedGenerationMovement, 8);
  assert.equal(report.lifecycle.finalCoordinator?.active, 0);
  assert.equal(report.lifecycle.finalCoordinator?.pending, 0);
  assert.equal(report.lifecycle.finalCoordinator?.activeNetwork, 0);
  assert.equal(report.lifecycle.finalCoordinator?.statusInFlight, 0);
  assert.equal(report.lifecycle.finalCoordinator?.clonePending, 0);
  assert.equal(report.lifecycle.finalCoordinator?.cloneDestinations, 0);
  assert.equal(report.lifecycle.activeHarnessSubmissions, 0);
  assert.equal(report.lifecycle.activeHarnessGitChildren, 0);
  assert.equal(report.lifecycle.fixtureCleanupSucceeded, true);
  assert.equal((report.details.parity as { equal?: boolean }).equal, true);
  assert.ok(report.environment.gitVersion.startsWith('git version'));
  assert.match(report.environment.gitChildScope, /excludes Git helpers and external processes/i);
  assert.equal('gitSafety' in report.environment, false);
  assert.equal(report.safety.passed, true);
  assert.equal(report.safety.outputBoundary.mode, 'stdout-only');
  assert.equal(report.safety.guards['child-cwd-boundary'].passed, 31);
  assert.equal(report.safety.guards['child-path-operands'].passed, 31);
  assert.equal(report.safety.guards['child-environment'].passed, 31);
  assert.equal(report.safety.guards['child-git-configuration'].passed, 31);
  assert.equal(report.safety.guards['local-remote-policy'].passed, 31);
  assert.deepEqual(report.safety.evidence.failedGuardCodes, []);
  assert.deepEqual(report.operations.gitCommandsByCategory, {
    environment: 1,
    'fixture-setup': 20,
    discovery: 2,
    workload: 6,
    'lock-recovery': 2,
    cleanup: 0,
  });
  assert.equal(report.operations.gitCommandAccounting.expectedTotal, 31);
  assert.equal(report.operations.gitCommandAccounting.expectedSuccesses, 30);
  assert.equal(report.operations.gitCommandAccounting.expectedFailures, 1);
  assert.equal(report.operations.gitCommandAccounting.observedCategorySum, 31);
  assert.equal(report.operations.gitCommandAccounting.observedClassSum, 31);
  assert.ok(report.operations.gitCommandsByClass['startup-status'] >= 2);
  assert.equal(report.latency.underlyingScheduledOperations['startup-status']?.totalMs.count, 2);
  assert.equal(report.latency.allWaitersObservedTotalMs['startup-status']?.count, 2);
  assert.match(report.latency.contract.allWaitersObservedTotalMs, /one exact observed-total sample per coordinator API submission/);
});

test('Git child timeout waits for graceful close before balancing metrics and cleaning the fixture', { timeout: 15_000 }, async () => {
  const report = await runFocusedGitExecutionProfile({
    profile: 'pr-real',
    gitChildTimeoutMs: 200,
    testHooks: {
      gitChildTimeoutProbe: {
        operationClass: 'environment',
        terminationGraceMs: 500,
      },
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.config.gitChildTimeoutMs, 200);
  assert.equal(report.lifecycle.unexpectedErrors, 1);
  assert.equal(report.lifecycle.gitChildTimeouts, 1);
  assert.equal(report.lifecycle.gitChildTerminationAttempts, 1);
  assert.equal(report.lifecycle.gitChildGracefulTerminations, 1);
  assert.equal(report.lifecycle.gitChildForcedTerminations, 0);
  assert.equal(report.lifecycle.gitChildReapedAfterTimeout, 1);
  assert.equal(report.lifecycle.activeHarnessGitChildren, 0);
  assert.equal(report.lifecycle.activeHarnessSubmissions, 0);
  assert.equal(report.lifecycle.fixtureCleanupSucceeded, true);
  assert.equal(report.cardinality.gitCommands, 1);
  assert.equal(report.operations.gitCommandSuccesses, 0);
  assert.equal(report.operations.gitCommandFailures, 1);
  assert.equal(report.safety.passed, true);
  assert.deepEqual(report.details.unexpectedException, {
    name: 'GitChildTimeoutError',
    message: 'git --version exceeded the harness child timeout of 200ms',
  });
});

test('Git child timeout force-escalates only when graceful termination does not close the child', { timeout: 15_000 }, async () => {
  const report = await runFocusedGitExecutionProfile({
    profile: 'pr-real',
    gitChildTimeoutMs: 200,
    testHooks: {
      gitChildTimeoutProbe: {
        operationClass: 'startup-status',
        ignoreSigterm: true,
        terminationGraceMs: 50,
      },
    },
  });

  assert.equal(report.passed, false);
  assert.equal(report.lifecycle.gitChildTimeouts, 1);
  assert.equal(report.lifecycle.gitChildTerminationAttempts, 1);
  assert.equal(report.lifecycle.gitChildReapedAfterTimeout, 1);
  assert.equal(report.lifecycle.activeHarnessGitChildren, 0);
  assert.equal(report.lifecycle.activeHarnessSubmissions, 0);
  assert.equal(report.lifecycle.fixtureCleanupSucceeded, true);
  assert.equal(report.operations.statusWaiters, 2);
  assert.equal(report.operations.statusUnderlyingScheduledOperations, 2);
  assert.ok(report.peaks.topLevelOperations > 0);
  assert.equal(
    report.operations.gitCommandSuccesses + report.operations.gitCommandFailures,
    report.cardinality.gitCommands,
  );
  if (process.platform === 'win32') {
    assert.equal(report.lifecycle.gitChildGracefulTerminations, 1);
    assert.equal(report.lifecycle.gitChildForcedTerminations, 0);
  } else {
    assert.equal(report.lifecycle.gitChildGracefulTerminations, 0);
    assert.equal(report.lifecycle.gitChildForcedTerminations, 1);
  }
});

test('reduced target preserves entity mapping, scenario, waiter, and command dimensions', { timeout: 60_000 }, async () => {
  const report = await runFocusedGitExecutionProfile({
    profile: 'target-real',
    development: true,
    seed: PROFILE_DEFAULTS.seed,
  });

  if (!report.passed) {
    console.error(JSON.stringify(report.assertions.filter((assertion) => !assertion.passed), null, 2));
  }
  assert.equal(report.passed, true);
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(report.cardinality.entityMapping, {
    applicable: true,
    sessionEntities: 600,
    worktreeIdentities: 6,
    coordinatorApiSubmissions: 0,
    underlyingScheduledOperations: 0,
    gitCommands: 0,
  });
  assert.deepEqual(report.cardinality.scenarios.startup, {
    logicalCallers: 6,
    coordinatorApiSubmissions: 6,
    underlyingScheduledOperations: 6,
    gitCommands: 6,
  });
  assert.deepEqual(report.cardinality.scenarios['pathological-fanout'], {
    logicalCallers: 600,
    coordinatorApiSubmissions: 600,
    underlyingScheduledOperations: 6,
    gitCommands: 6,
  });
  assert.deepEqual(report.cardinality.scenarios['mixed-workload'], {
    logicalCallers: 15,
    coordinatorApiSubmissions: 15,
    underlyingScheduledOperations: 15,
    gitCommands: 15,
  });
  assert.equal(report.cardinality.coordinatorApiSubmissions, 623);
  assert.equal(report.cardinality.underlyingScheduledOperations, 29);
  assert.equal(report.cardinality.gitCommands, 75);
  assert.equal(report.latency.allWaitersObservedTotalMs['pathological-fanout-status']?.count, 600);
  assert.equal(report.latency.underlyingScheduledOperations['pathological-fanout-status']?.totalMs.count, 6);
  assert.deepEqual(report.operations.gitCommandsByCategory, {
    environment: 1,
    'fixture-setup': 39,
    discovery: 6,
    workload: 27,
    'lock-recovery': 2,
    cleanup: 0,
  });
  assert.equal(report.operations.gitCommandAccounting.expectedTotal, 75);
  assert.equal(report.safety.guards['child-environment'].passed, 75);
  assert.equal(report.safety.evidence.childEnvironmentChecksEqualGitCommands, true);
});

test('web and VS Code pure coordinator fixtures remain deterministic peers', async () => {
  const parity = await runCoordinatorParityAssertions();
  assert.equal(parity.equal, true);
  assert.deepEqual(parity.web, parity.vscode);
});

test('target and manual profile defaults keep entities separate from callers', () => {
  assert.equal(PROFILE_DEFAULTS.targetReal.sessionRecords, 30_000);
  assert.equal(PROFILE_DEFAULTS.targetReal.commonDirectories, 200);
  assert.equal(PROFILE_DEFAULTS.targetReal.linkedWorktrees, 100);
  assert.equal(PROFILE_DEFAULTS.targetReal.worktreeIdentities, 300);
  assert.equal(PROFILE_DEFAULTS.targetReal.startupCallers, 300);
  assert.equal(PROFILE_DEFAULTS.targetReal.fanoutCallers, 30_000);
  assert.equal(PROFILE_DEFAULTS.targetReal.mutations, 600);
  assert.equal(PROFILE_DEFAULTS.targetReal.fetches, 60);
  assert.equal(PROFILE_DEFAULTS.gitChildTimeoutMs, 60_000);
  assert.equal(PROFILE_DEFAULTS.soak.durationMs, 300_000);
  assert.equal(PROFILE_DEFAULTS.soak.rate, 20);
  assert.deepEqual([...PROFILE_DEFAULTS.capSweep.caps], [2, 4, 6, 8, 12]);
});

test('CLI accepts soak overrides only for soak and reports invalid non-soak use before execution', async () => {
  assert.throws(
    () => parseGitExecutionCliArgs(['--profile', 'pr-real', '--duration-ms', '1000']),
    /--duration-ms is only valid with --profile soak/,
  );
  assert.throws(
    () => parseGitExecutionCliArgs(['--rate', '2', '--profile', 'target-real']),
    /--rate is only valid with --profile soak/,
  );
  assert.deepEqual(
    parseGitExecutionCliArgs([
      '--duration-ms', '1000',
      '--profile', 'soak',
      '--rate', '2',
      '--git-child-timeout-ms', '750',
    ]),
    {
      durationMs: 1000,
      profile: 'soak',
      rate: 2,
      gitChildTimeoutMs: 750,
    },
  );

  const cli = await runHarnessCli(['--profile', 'cap-sweep', '--duration-ms', '1000']);
  assert.equal(cli.exitCode, 1);
  assert.equal(cli.stdout, '');
  assert.equal(cli.stderr.trim(), '--duration-ms is only valid with --profile soak');
});

test('focused and root test entrypoints cannot admit full target or five-minute soak implicitly', async () => {
  await assert.rejects(
    runFocusedGitExecutionProfile({ profile: 'target-real' }),
    /Focused test entrypoint forbids full target-real/,
  );
  await assert.rejects(
    runFocusedGitExecutionProfile({ profile: 'soak' }),
    /requires an explicit soak duration of at most 30000ms/,
  );
  await assert.rejects(
    runFocusedGitExecutionProfile({ profile: 'soak', durationMs: PROFILE_DEFAULTS.soak.durationMs }),
    /requires an explicit soak duration of at most 30000ms/,
  );

  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(packageJson.scripts['test:perf:git'], 'bun test scripts/perf/git-execution.test.ts');
  assert.deepEqual(
    Object.entries(packageJson.scripts)
      .filter(([, command]) => command.includes('scripts/perf/git-execution.ts --profile target-real'))
      .filter(([, command]) => !command.includes('--development'))
      .map(([name]) => name),
    ['perf:git:target-real'],
  );
  assert.deepEqual(
    Object.entries(packageJson.scripts)
      .filter(([, command]) => command.includes('scripts/perf/git-execution.ts --profile soak'))
      .map(([name]) => name),
    ['perf:git:soak'],
  );
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (!name.includes('test')) continue;
    assert.doesNotMatch(command, /perf:git:(?:target-real|soak)/);
  }
});

test('default soak plan fixes status groups and exact equations before execution', () => {
  const plan = inspectGitExecutionSoakPlan({ seed: PROFILE_DEFAULTS.seed });

  assert.equal(plan.generatedBeforeExecution, true);
  assert.equal(plan.statusWaveMs, 1_000);
  assert.equal(plan.topologyEvery, 100);
  assert.equal(plan.idleEvery, 200);
  assert.deepEqual(plan.callerCounts, {
    topology: 59,
    status: 3_279,
    diff: 1_163,
    mutation: 1_146,
    fetch: 353,
  });
  assert.equal(plan.statusGroups, 1_869);
  assert.deepEqual(plan.statusGroupSizeCounts, {
    1: 969,
    2: 552,
    3: 224,
    4: 93,
    5: 25,
    6: 5,
    7: 1,
  });
  assert.deepEqual(plan.expected, {
    logicalCallers: 6_000,
    coordinatorApiSubmissions: 6_000,
    underlyingScheduledOperations: 4_590,
    gitCommands: 4_754,
    generationMovement: 3_116,
  });
  assert.deepEqual(plan.gitCommandsByCategory, {
    environment: 1,
    'fixture-setup': 39,
    discovery: 6,
    workload: 4_649,
    'lock-recovery': 0,
    cleanup: 59,
  });
  assert.equal(
    plan.gitCommandEquation,
    '1 environment + 39 fixture-setup + 6 discovery + 4649 workload + 0 lock-recovery + 59 cleanup = 4754',
  );
});

test('soak status groups stay exact across seeds and variable task durations', { timeout: 90_000 }, async () => {
  const run = async (seed: number, delayPattern?: readonly number[]) => {
    const report = await runFocusedGitExecutionProfile({
      profile: 'soak',
      seed,
      durationMs: 1_200,
      rate: 40,
      ...(delayPattern ? { testHooks: { soakStatusDelayPatternMs: delayPattern } } : {}),
    });
    if (!report.passed) {
      console.error(JSON.stringify(report.assertions.filter((assertion) => !assertion.passed), null, 2));
    }
    assert.equal(report.passed, true);
    return report;
  };

  const baseline = await run(PROFILE_DEFAULTS.seed);
  const delayed = await run(PROFILE_DEFAULTS.seed, [0, 75, 5, 120]);
  const alternateSeed = await run(4_660, [120, 0, 35, 5]);
  const baselinePlan = baseline.details.immutablePlan as GitExecutionSoakPlanSummary;
  const delayedPlan = delayed.details.immutablePlan as GitExecutionSoakPlanSummary;
  const alternatePlan = alternateSeed.details.immutablePlan as GitExecutionSoakPlanSummary;

  assert.deepEqual(delayedPlan, baselinePlan);
  assert.deepEqual(baselinePlan.expected, {
    logicalCallers: 48,
    coordinatorApiSubmissions: 48,
    underlyingScheduledOperations: 33,
    gitCommands: 79,
    generationMovement: 22,
  });
  assert.deepEqual(baselinePlan.callerCounts, {
    topology: 0,
    status: 30,
    diff: 7,
    mutation: 7,
    fetch: 4,
  });
  assert.equal(baselinePlan.statusGroups, 15);
  assert.equal(baseline.operations.statusWaiters, 30);
  assert.equal(baseline.operations.statusUnderlyingScheduledOperations, 15);
  assert.equal(delayed.operations.statusWaiters, 30);
  assert.equal(delayed.operations.statusUnderlyingScheduledOperations, 15);
  assert.deepEqual(delayed.cardinality.scenarios.soak, {
    logicalCallers: 48,
    coordinatorApiSubmissions: 48,
    underlyingScheduledOperations: 33,
    gitCommands: 33,
  });

  assert.deepEqual(alternatePlan.expected, {
    logicalCallers: 48,
    coordinatorApiSubmissions: 48,
    underlyingScheduledOperations: 38,
    gitCommands: 84,
    generationMovement: 24,
  });
  assert.equal(alternatePlan.callerCounts.status, 26);
  assert.equal(alternatePlan.statusGroups, 16);
  assert.equal(alternateSeed.operations.statusWaiters, 26);
  assert.equal(alternateSeed.operations.statusUnderlyingScheduledOperations, 16);
});

test('explicit output inside the workspace is rejected before a profile can spawn Git', async () => {
  await assert.rejects(
    runFocusedGitExecutionProfile({ profile: 'pr-real', output: path.join(process.cwd(), 'stale-report.json') }),
    /outside the project workspace/,
  );
});

test('explicit output uses one new canonical file outside the workspace and never overwrites it', { timeout: 45_000 }, async () => {
  const outputDirectory = await mkdtemp(path.join(tmpdir(), 'openchamber-git-perf-output-test-'));
  const outputPath = path.join(outputDirectory, 'report.json');
  try {
    const report = await runFocusedGitExecutionProfile({ profile: 'pr-real', output: outputPath });
    const written = JSON.parse(await readFile(outputPath, 'utf8')) as typeof report;
    assert.equal(report.passed, true);
    assert.equal(report.safety.outputBoundary.mode, 'explicit-single-file');
    assert.equal(report.safety.outputBoundary.policy, 'canonical-path-outside-workspace');
    assert.equal(written.schemaVersion, 2);
    assert.equal(written.passed, true);
    await assert.rejects(
      runFocusedGitExecutionProfile({ profile: 'pr-real', output: outputPath }),
      /existing files are never overwritten/,
    );
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
