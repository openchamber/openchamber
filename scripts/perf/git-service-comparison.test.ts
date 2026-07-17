import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  GIT_SERVICE_COMPARISON_DEFAULTS,
  inspectGitServiceComparisonProfile,
  parseGitServiceComparisonCliArgs,
  runFocusedGitServiceComparison,
} from './git-service-comparison.ts';

const runHarnessCli = async (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => (
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(process.cwd(), 'scripts/perf/git-service-comparison.ts'), ...args], {
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

test('comparison profiles separate 30,000 entities from pathological concurrent callers', () => {
  const target = inspectGitServiceComparisonProfile('target');
  const pathological = inspectGitServiceComparisonProfile('pathological-fanout');

  assert.deepEqual(target, {
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
  assert.deepEqual(pathological, {
    ...target,
    fanoutCallers: 30_000,
    fanoutBatchSize: 600,
  });
  assert.equal(GIT_SERVICE_COMPARISON_DEFAULTS.baselineRef, '4c2f8946b');
  assert.equal(GIT_SERVICE_COMPARISON_DEFAULTS.architectureCommit, '57c297527');
});

test('CLI requires explicit opt-in for the pathological 30,000-caller profile', () => {
  assert.throws(
    () => parseGitServiceComparisonCliArgs(['--profile', 'pathological-fanout']),
    /requires explicit --allow-pathological/,
  );
  assert.deepEqual(
    parseGitServiceComparisonCliArgs([
      '--profile', 'pathological-fanout',
      '--allow-pathological',
      '--baseline-ref', '4c2f8946b',
      '--seed', '8755',
    ]),
    {
      profile: 'pathological-fanout',
      baselineRef: '4c2f8946b',
      seed: 8755,
      allowPathological: true,
      order: 'before-first',
    },
  );
  assert.equal(parseGitServiceComparisonCliArgs(['--order', 'after-first']).order, 'after-first');
  assert.throws(
    () => parseGitServiceComparisonCliArgs(['--baseline-ref', 'HEAD~1']),
    /hexadecimal commit ID|baseline-ref/,
  );
});

test('current/current smoke proves architecture-neutral correctness and launch accounting', {
  timeout: 120_000,
  skip: process.platform === 'win32' ? 'exact launch counting currently uses a POSIX shim' : false,
}, async () => {
  const report = await runFocusedGitServiceComparison();
  if (!report.passed) {
    console.error(JSON.stringify({ before: report.before, after: report.after }, null, 2));
  }

  assert.equal(report.passed, true);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.profile, 'smoke');
  assert.equal(report.comparison.valid, true);
  assert.equal(report.before.sourceHash, report.after.sourceHash);
  assert.equal(report.before.cardinality.sessionEntities, 60);
  assert.equal(report.before.cardinality.uniqueCommonDirectories, 2);
  assert.equal(report.before.cardinality.uniqueWorktreeIdentities, 3);
  assert.equal(report.before.cardinality.serviceCalls, 11);
  assert.equal(report.after.cardinality.serviceCalls, 11);
  assert.equal(report.before.scenarios.entityMapping.gitLaunches, 0);
  assert.equal(report.after.scenarios.entityMapping.gitLaunches, 0);
  assert.equal(report.before.scenarios.startupStatus.logicalCallers, 3);
  assert.equal(report.after.scenarios.startupStatus.logicalCallers, 3);
  assert.equal(report.before.scenarios.mixedWorkload.logicalCallers, 8);
  assert.equal(report.after.scenarios.mixedWorkload.logicalCallers, 8);
  assert.equal(report.before.scenarios.pathologicalFanout, null);
  assert.equal(report.after.scenarios.pathologicalFanout, null);
  assert.equal(report.before.latencyMs.startupStatus.count, 3);
  assert.equal(report.after.latencyMs.startupStatus.count, 3);
  assert.equal(report.before.latencyMs.mutation.count, 6);
  assert.equal(report.after.latencyMs.mutation.count, 6);
  assert.equal(report.before.latencyMs.fetch.count, 2);
  assert.equal(report.after.latencyMs.fetch.count, 2);
  assert.equal(report.before.correctness.failures, 0);
  assert.equal(report.after.correctness.failures, 0);
  assert.equal(report.before.cleanupSucceeded, true);
  assert.equal(report.after.cleanupSucceeded, true);
  assert.ok(report.before.gitProcesses.totalLaunches > 0);
  assert.equal(report.before.gitProcesses.totalLaunches, report.after.gitProcesses.totalLaunches);
  assert.equal(report.before.gitProcesses.unclassifiedLaunches, 0);
  assert.equal(report.after.gitProcesses.unclassifiedLaunches, 0);
  assert.equal(
    report.before.gitProcesses.totalLaunches,
    report.before.scenarios.startupStatus.gitLaunches + report.before.scenarios.mixedWorkload.gitLaunches,
  );
  assert.equal(
    report.after.gitProcesses.totalLaunches,
    report.after.scenarios.startupStatus.gitLaunches + report.after.scenarios.mixedWorkload.gitLaunches,
  );
});

test('normal test scripts cannot invoke target or pathological comparison profiles', async () => {
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts['test:perf:git:comparison'],
    'bun test scripts/perf/git-service-comparison.test.ts',
  );
  assert.equal(
    packageJson.scripts['perf:git:compare:target'],
    'bun scripts/perf/git-service-comparison.ts --profile target',
  );
  assert.equal(
    packageJson.scripts['perf:git:compare:pathological'],
    'bun scripts/perf/git-service-comparison.ts --profile pathological-fanout --allow-pathological',
  );
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    if (!name.includes('test')) continue;
    assert.doesNotMatch(command, /git-service-comparison\.ts --profile (?:target|pathological-fanout)/);
  }
});

test('internal worker mode rejects cleanup targets outside its unique comparison root', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'openchamber-git-service-invalid-worker-'));
  const configPath = path.join(directory, 'worker.json');
  try {
    await writeFile(configPath, JSON.stringify({
      label: 'before',
      profile: 'smoke',
      workload: GIT_SERVICE_COMPARISON_DEFAULTS.smoke,
      seed: GIT_SERVICE_COMPARISON_DEFAULTS.seed,
      servicePath: path.join(process.cwd(), 'packages/web/server/lib/git/service.js'),
      sourceHash: '0'.repeat(64),
      comparisonRoot: process.cwd(),
      fixtureRoot: path.join(process.cwd(), 'must-not-be-removed'),
      realGit: '/usr/bin/git',
    }), 'utf8');
    const result = await runHarnessCli(['--worker-config', configPath]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /outside the approved temporary boundary/);
    assert.ok((await readFile(path.join(process.cwd(), 'package.json'), 'utf8')).includes('"name"'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
