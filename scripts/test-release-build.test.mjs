import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import yaml from 'yaml';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scriptPath = fileURLToPath(new URL('./test-release-build.sh', import.meta.url));
const workflow = yaml.parse(fs.readFileSync(`${repoRoot}/.github/workflows/release.yml`, 'utf8'));
const macosJob = workflow.jobs['build-desktop-electron-macos'];
const buildStep = macosJob.steps.find((step) => step.name === 'Build Electron app');
const electronPackage = JSON.parse(fs.readFileSync(`${repoRoot}/packages/electron/package.json`, 'utf8'));
const rootPackage = JSON.parse(fs.readFileSync(`${repoRoot}/package.json`, 'utf8'));

// Workflow matrix arch value for each script target.
const targets = [
  { target: 'aarch64', arch: 'arm64', targetTriple: 'aarch64-apple-darwin' },
  { target: 'x86_64', arch: 'x64', targetTriple: 'x86_64-apple-darwin' },
];

const runScript = (args) =>
  spawnSync('bash', [scriptPath, ...args], { cwd: repoRoot, encoding: 'utf8' });

// Command lines of the workflow's "Build Electron app" step for one matrix arch.
const workflowCommands = (arch) =>
  buildStep.run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.replaceAll('${{ matrix.arch }}', arch));

const dryRunCommands = (stdout) =>
  [...stdout.matchAll(/^\[dry-run\] (\S+)\$ (.+)$/gm)].map((match) => ({
    dir: match[1],
    command: match[2],
  }));

test('the release test targets the workflow matrix runners and their Electron Builder arch', () => {
  const matrixArches = macosJob.strategy.matrix.include;
  for (const { arch, targetTriple } of targets) {
    const entry = matrixArches.find((item) => item.target === targetTriple);
    assert.ok(entry, `workflow matrix has ${targetTriple}`);
    assert.equal(entry.arch, arch);
  }
});

test('dry run prints the workflow build commands for each architecture, and no build runs', () => {
  for (const { target, arch } of targets) {
    const result = runScript([target, '--dry-run']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Dry run complete\. No build ran\./);
    assert.doesNotMatch(result.stdout, /Electron build finished/);

    const printed = dryRunCommands(result.stdout);
    const expected = [
      'bun install --frozen-lockfile',
      ...workflowCommands(arch),
    ];
    assert.deepEqual(
      printed.map((entry) => entry.command),
      expected,
      `dry run for ${target} matches release.yml commands for ${arch}`,
    );
  }
});

test('every directory and bun script named by the dry run exists in the repository', () => {
  const result = runScript(['all', '--dry-run']);
  assert.equal(result.status, 0, result.stderr);

  const printed = dryRunCommands(result.stdout);
  assert.ok(printed.length > 0);
  for (const { dir, command } of printed) {
    const packageDir = dir === '.' ? repoRoot : `${repoRoot}/${dir}`;
    assert.ok(fs.existsSync(`${packageDir}/package.json`), `${dir}/package.json exists`);

    const runMatch = command.match(/^bun run (\S+)$/);
    if (runMatch) {
      const pkg = JSON.parse(fs.readFileSync(`${packageDir}/package.json`, 'utf8'));
      assert.ok(pkg.scripts?.[runMatch[1]], `${dir} defines script ${runMatch[1]}`);
    }
    if (command.startsWith('bunx electron-builder ')) {
      assert.ok(electronPackage.devDependencies['electron-builder'], 'electron-builder is a dev dependency');
    }
  }
});

test('package scripts route the documented macOS checks to this tester', () => {
  assert.equal(rootPackage.scripts['release:test:intel'], './scripts/test-release-build.sh x86_64');
  assert.equal(rootPackage.scripts['release:test:arm'], './scripts/test-release-build.sh aarch64');
  assert.equal(rootPackage.scripts['release:test'], './scripts/test-release-build.sh');
});

test('a real run on a non-macOS host stops before any build step', (t) => {
  if (process.platform === 'darwin') {
    t.skip('macOS host runs the real build');
    return;
  }
  const result = runScript(['aarch64']);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /only on macOS/);
  assert.doesNotMatch(result.stdout, /Building Electron app/);
});
