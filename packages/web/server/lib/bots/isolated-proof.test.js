import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOT_ISOLATED_PROOF_PROGRAM } from './isolated-stages.js';

// Executes the container's exact program on disposable Linux files. This proves
// snapshot/process semantics and makes no claim about container isolation.
describe.skipIf(process.platform !== 'linux')('isolated proof program', () => {
  let directory; let root; let testSha; let fixSha; let laterSha;
  const env = { ...process.env, GIT_MASTER: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const git = (args) => execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, env, encoding: 'utf8', windowsHide: true });
  const commit = (message) => {
    git(['add', '.']); git(['-c', 'user.name=Proof fixture', '-c', 'user.email=proof@example.test', 'commit', '-qm', message]);
    return git(['rev-parse', 'HEAD']).trim();
  };
  beforeAll(async () => {
    await fs.mkdir('/tmp/opencode', { recursive: true }); root = await fs.mkdtemp('/tmp/opencode/bot-isolated-proof-'); directory = path.join(root, 'repo'); await fs.mkdir(directory);
    git(['init', '-q']);
    await fs.writeFile(path.join(directory, 'calc.cjs'), 'exports.value = 0;\n'); commit('base');
    await fs.writeFile(path.join(directory, 'regression.test.cjs'), "require('node:assert/strict').equal(require('./calc.cjs').value, 1);\n"); testSha = commit('regression');
    await fs.writeFile(path.join(directory, 'calc.cjs'), 'exports.value = 1;\n'); fixSha = commit('fix');
    await fs.writeFile(path.join(directory, 'calc.cjs'), 'exports.value = 99;\n'); laterSha = commit('later broken head');
  });
  afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
  const run = (patch = {}) => {
    const result = spawnSync(process.execPath, ['-e', BOT_ISOLATED_PROOF_PROGRAM], { env, encoding: 'utf8', timeout: 30_000,
      input: JSON.stringify({ directory, testSha, fixSha, command: process.execPath, args: ['--test', '{files}'], ...patch }),
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout);
  };
  it('runs the recorded test/fix snapshots, leaving the later agent checkout unchanged', () => {
    expect(run()).toMatchObject({ status: 'passed', testSha, fixSha, testExitCode: 1, fixExitCode: 0, args: ['--test', 'regression.test.cjs'] });
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(laterSha);
    expect(git(['status', '--porcelain'])).toBe('');
    expect(git(['worktree', 'list', '--porcelain']).match(/^worktree /gm)).toHaveLength(1);
  });
  it('refuses a still-broken fix and treats missing executables as inconclusive', () => {
    expect(run({ fixSha: laterSha })).toMatchObject({ status: 'failed', testExitCode: 1, fixExitCode: 1 });
    expect(run({ command: path.join(root, 'missing') })).toMatchObject({ status: 'inconclusive', testExitCode: null, fixExitCode: null });
  });
});
