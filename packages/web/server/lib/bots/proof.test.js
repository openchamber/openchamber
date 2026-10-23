import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { watch } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBotProofRunner } from './proof.js';

let root;
let directory;
let runner;
let testSha;
let fixSha;
let laterSha;
let brokenSha;
const git = (args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], { cwd: directory, encoding: 'utf8', windowsHide: true });
const commit = (message) => {
  git(['add', '.']);
  git(['-c', 'user.name=Bot QA', '-c', 'user.email=bot-qa@example.test', 'commit', '-qm', message]);
  return git(['rev-parse', 'HEAD']).trim();
};

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-bot-proof-'));
  directory = path.join(root, 'repo');
  await fs.mkdir(directory);
  git(['init', '-q']);
  await fs.writeFile(path.join(directory, 'calc.mjs'), 'export const sum = () => 0;\n');
  commit('base');
  await fs.writeFile(path.join(directory, 'regression.test.mjs'), "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { sum } from './calc.mjs';\ntest('sum returns its result', () => assert.equal(sum(), 1));\n");
  testSha = commit('regression test');
  await fs.writeFile(path.join(directory, 'calc.mjs'), 'export const sum = () => 1;\n');
  fixSha = commit('fix');
  await fs.writeFile(path.join(directory, 'README.md'), '# Proof fixture\n');
  laterSha = commit('documentation');
  await fs.writeFile(path.join(directory, 'calc.mjs'), 'export const sum = () => 0;\n');
  brokenSha = commit('reintroduce defect');
  runner = createBotProofRunner({ root: path.join(root, 'checkouts') });
});
afterAll(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });
const request = () => ({ directory, testSha, fixSha, command: process.execPath, args: ['--test', '{files}'] });

describe('server-run bot proof', () => {
  it('proves the same regression fails before the fix and passes after it', async () => {
    // Given a real Git history with a regression test followed by its fix.
    const input = request();
    const head = git(['rev-parse', 'HEAD']).trim();
    // When the server runs both snapshots using the user-configured executable.
    const result = await runner.run(input);
    // Then proof records immutable commits, the server-derived files and both exits.
    expect(result).toMatchObject({ status: 'passed', testSha, fixSha, testExitCode: 1, fixExitCode: 0, args: ['--test', 'regression.test.mjs'] });
    expect(git(['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(git(['status', '--porcelain'])).toBe('');
    expect((await fs.readdir(path.join(root, 'checkouts')))).toEqual([]);
  });

  it('rejects proof when the regression also passes without the fix', async () => {
    // Given a test commit where the defect is already fixed.
    const input = { ...request(), testSha: fixSha, fixSha: laterSha, args: ['--test', 'regression.test.mjs'] };
    // When both snapshots run, the first success invalidates the proof.
    const result = await runner.run(input);
    // Then passing tests alone do not qualify as proof.
    expect(result).toMatchObject({ status: 'failed', testExitCode: 0, fixExitCode: 0 });
  });

  it('rejects proof when the test still fails with the fix', async () => {
    // Given a descendant commit which still has the defect.
    const input = { ...request(), fixSha: brokenSha };
    // When the server executes the unchanged regression in both snapshots.
    const result = await runner.run(input);
    // Then the failing fixed snapshot prevents merge admission.
    expect(result).toMatchObject({ status: 'failed', testExitCode: 1, fixExitCode: 1 });
  });

  it('records a missing executable as inconclusive rather than a failing test', async () => {
    // Given an unavailable configured test executable.
    const input = { ...request(), command: path.join(root, 'missing-test-runner') };
    // When the first test process cannot start.
    const result = await runner.run(input);
    // Then no red result is claimed and the green process does not run.
    expect(result).toMatchObject({ status: 'inconclusive', testExitCode: null, fixExitCode: null });
  });

  it('never falls back to the host for a requested isolated proof', async () => {
    // Given an isolated item and no available isolated executor.
    const input = { ...request(), isolated: true };
    // When proof is requested.
    const result = await runner.run(input);
    // Then both exit codes remain unknown and the host executed no test.
    expect(result).toMatchObject({ status: 'inconclusive', testExitCode: null, fixExitCode: null });
  });

  it('rejects option-shaped commit identifiers at the boundary', async () => {
    // Given an invalid identifier which could otherwise become a Git option.
    const input = { ...request(), testSha: '--help' };
    // When it crosses the proof boundary, parsing refuses it before Git runs.
    await expect(runner.run(input)).rejects.toThrow();
  });

  it('bounds a nonterminating proof command and removes its temporary checkouts', async () => {
    // Given an executable that stays alive instead of producing a test result.
    const controller = new AbortController();
    const failSafe = setTimeout(() => controller.abort(), 5_000);
    const bounded = createBotProofRunner({ root: path.join(root, 'bounded-checkouts'), timeoutMs: 100 });
    try {
      // When the proof execution deadline expires.
      const result = await bounded.run({ ...request(), args: ['-e', 'setInterval(() => {}, 1000)'] }, { signal: controller.signal });
      // Then cancellation is inconclusive and cleanup completes before returning.
      expect(controller.signal.aborted).toBe(false);
      expect(result).toMatchObject({ status: 'inconclusive', testExitCode: null, fixExitCode: null });
      expect(await fs.readdir(path.join(root, 'bounded-checkouts'))).toEqual([]);
      expect(git(['worktree', 'list', '--porcelain'])).not.toContain('bounded-checkouts');
    } finally { clearTimeout(failSafe); }
  }, 10_000);

  it.skipIf(process.platform !== 'linux')('terminates a proof process and its SIGTERM-resistant descendant before cleanup', async () => {
    // Given a real proof runner whose parent and child both ignore graceful termination.
    const pidFile = path.join(root, 'proof-pids.json');
    let watcher;
    const ready = new Promise((resolve, reject) => {
      watcher = watch(root, async (_event, file) => {
        if (file !== 'proof-pids.json') return;
        try { resolve(JSON.parse(await fs.readFile(pidFile, 'utf8'))); }
        catch (error) { reject(error); }
      });
    });
    const program = `const cp=require('node:child_process'),fs=require('node:fs');
      process.on('SIGTERM',()=>{});
      const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.send(process.pid);setInterval(()=>{},1000)"],{stdio:['ignore','ignore','ignore','ipc']});
      child.on('message',pid=>{fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)},JSON.stringify([process.pid,pid]));fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)},${JSON.stringify(pidFile)});});
      setTimeout(()=>{child.kill('SIGKILL');process.exit(0)},6000);`;
    const controller = new AbortController();
    const running = runner.run({ ...request(), args: ['-e', program] }, { signal: controller.signal });
    let pids = [];
    try {
      pids = await ready;
      for (const pid of pids) expect(process.kill(pid, 0)).toBe(true);
      // When the owning item cancels proof after both processes have started.
      controller.abort();
      const result = await running;
      // Then neither process can execute or retain a checkout after completion.
      expect(result.status).toBe('inconclusive');
      for (const pid of pids) {
        const state = await fs.readFile(`/proc/${pid}/stat`, 'utf8').catch((error) => {
          if (error.code === 'ENOENT') return '';
          throw error;
        });
        expect(state === '' || /\) Z /.test(state)).toBe(true);
      }
      expect(await fs.readdir(path.join(root, 'checkouts'))).toEqual([]);
    } finally {
      controller.abort();
      watcher.close();
      for (const pid of pids) {
        try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      await running;
    }
  }, 10_000);
});
