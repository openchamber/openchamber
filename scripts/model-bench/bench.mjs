#!/usr/bin/env node
// Model bench: replays a real OpenChamber commit as a task for a model.
//
//   node scripts/model-bench/bench.mjs validate <task|all>
//   node scripts/model-bench/bench.mjs run <task|all> <provider/model[#variant]>... [--parallel N] [--keep]
//
// A run copies the repository at the commit's parent into a fresh folder with
// no git history (so the model cannot read the real fix), lets `opencode run`
// work there, then drops in the commit's own tests and runs them. Every
// task × model pair goes into one queue that runs N at a time. Results go to
// ~/.config/openchamber/model-bench/results.jsonl; each run's patch, event log
// and test output stay in ~/.cache/openchamber-model-bench/results/<run>/, and
// the copy itself is deleted unless --keep is given.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const tasks = JSON.parse(readFileSync(path.join(here, 'tasks.json'), 'utf8'));
const benchHome = path.join(os.homedir(), '.config/openchamber/model-bench');
const cacheRoot = path.join(os.homedir(), '.cache/openchamber-model-bench');

// Generous on purpose: slow models still finish hard tasks, and `minutes` in
// each record answers "within a ten-minute session" separately. --timeout N
// (minutes) overrides it.
let RUN_TIMEOUT_MS = 30 * 60 * 1000;
// No event from the model for this long means it hangs (a question nobody
// answers, a server it waits on). A long test run inside one tool call stays
// well under it.
const IDLE_TIMEOUT_MS = 6 * 60 * 1000;
const REPO_GUARD_INTERVAL_MS = 15 * 1000;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

const PROMPT_SUFFIX = [
  '',
  '',
  'Work in this folder only. Do not commit, and do not start a review subagent.',
  'Do not start dev servers, Electron, browsers or production builds: verify with the tests for the code you touch and a type-check.',
  'Work from this folder\'s code only: do not look this project up on GitHub or the web.',
  'Nobody can answer questions during this task: decide open points yourself and say what you decided.',
].join('\n');

const sh = (cmd, opts = {}) => spawnSync('/bin/zsh', ['-c', cmd], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const must = (cmd, opts) => {
  const r = sh(cmd, opts);
  if (r.status !== 0) throw new Error(`${cmd}\n${r.stderr || r.stdout}`);
  return r.stdout;
};

// Every child gets its own process group, so killing the group also takes the
// servers and test runners a model started from its shell.
const active = new Set();
const killGroup = (child, signal = 'SIGTERM') => {
  try { process.kill(-child.pid, signal); } catch { /* already gone */ }
};
const stopGroup = (child) => {
  killGroup(child, 'SIGTERM');
  setTimeout(() => killGroup(child, 'SIGKILL'), 5000).unref();
};

const shAsync = (cmd, { cwd, timeout } = {}) => new Promise((resolve) => {
  const child = spawn('/bin/zsh', ['-c', cmd], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  active.add(child);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const timer = timeout ? setTimeout(() => stopGroup(child), timeout) : null;
  child.on('close', (code) => {
    if (timer) clearTimeout(timer);
    active.delete(child);
    resolve({ status: code, out });
  });
});
const mustAsync = async (cmd, opts) => {
  const r = await shAsync(cmd, opts);
  if (r.status !== 0) throw new Error(`${cmd}\n${r.out}`);
  return r.out;
};

const pickTasks = (id) => (id === 'all' ? tasks : tasks.filter((t) => t.id === id));

// The copy is a git repository with one commit, so `git diff` shows the model's
// change and nothing of the real history leaks in.
// A code task starts before its commit. A review task starts after the commit
// that brought the bug, which the model reviews from REVIEW.diff.
const isReview = (task) => task.type === 'review';
const prepare = async (task, dir) => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await mustAsync(`git -C ${repo} archive ${isReview(task) ? task.commit : `${task.commit}^`} | tar -x -C ${dir}`);
  if (isReview(task)) writeFileSync(path.join(dir, 'REVIEW.diff'), must(`git -C ${repo} show ${task.commit}`));
  // Dependencies as the commit's lockfile pins them: today's node_modules can be
  // a major version ahead of the code (simple-git 3 → 4 broke old git tests).
  // Bun clones packages from its cache, so a copy costs ~300 MB of real disk.
  await mustAsync('bun install --frozen-lockfile', { cwd: dir });
  await mustAsync('git init -q && git add -A && git -c user.name=bench -c user.email=bench@local commit -qm base', { cwd: dir });
};

const applyHiddenTests = (task, dir) => {
  for (const file of task.hiddenTests) {
    // `hiddenTestsFrom`: a later commit, when the fix's own test file was broken.
    const content = must(`git -C ${repo} show ${task.hiddenTestsFrom ?? task.commit}:${file}`);
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    writeFileSync(path.join(dir, file), content);
  }
};

const runTests = async (task, dir) => {
  const results = [];
  for (const { cwd, cmd } of task.testCommands) {
    const r = await shAsync(cmd, { cwd: path.join(dir, cwd), timeout: TEST_TIMEOUT_MS });
    results.push({ cmd, pass: r.status === 0, tail: r.out.split('\n').slice(-25).join('\n') });
  }
  return results;
};

const validate = async (task) => {
  const dir = path.join(cacheRoot, 'validate', task.id);
  await prepare(task, dir);
  applyHiddenTests(task, dir);
  const before = await runTests(task, dir);
  const excludes = task.hiddenTests.map((f) => `":!${f}"`).join(' ');
  must(`git -C ${repo} diff ${task.commit}^ ${task.commit} -- . ${excludes} | git apply --whitespace=nowarn`, { cwd: dir });
  const after = await runTests(task, dir);
  const ok = before.some((r) => !r.pass) && after.every((r) => r.pass);
  console.log(`${ok ? 'OK  ' : 'BAD '} ${task.id}: before ${before.map((r) => (r.pass ? 'pass' : 'fail')).join('/')}, after ${after.map((r) => (r.pass ? 'pass' : 'fail')).join('/')}`);
  if (!ok) for (const r of [...before, ...after]) console.log(`--- ${r.cmd} (${r.pass ? 'pass' : 'fail'})\n${r.tail}`);
  rmSync(dir, { recursive: true, force: true });
  return ok;
};

// The model must see only the copy. The calling shell may run inside the
// OpenChamber desktop app, whose env (OPENCODE_CONFIG, OPENCHAMBER_*) loads
// its plugins, memory and agent tools, and the user's global AGENTS.md names
// the real checkout's path: with them a model walked into the real repository
// and found the shipped fix. A private config home without either keeps
// provider logins, which live in the data home.
const isolatedEnv = (dir) => {
  const configHome = path.join(cacheRoot, 'xdg-config');
  mkdirSync(path.join(configHome, 'opencode'), { recursive: true });
  writeFileSync(path.join(configHome, 'opencode', 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    autoshare: false,
    shell: 'zsh',
    lsp: false,
    disabled_providers: ['claude-code'],
    // `--auto` approves everything not explicitly denied; file tools stay in the copy.
    // The repository is public: web tools fetched the shipped fix from GitHub.
    permissions: [
      { action: 'external_directory', resource: '*', effect: 'deny' },
      { action: 'webfetch', resource: '*', effect: 'deny' },
      { action: 'websearch', resource: '*', effect: 'deny' },
    ],
  }, null, 2));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(OPENCODE|OPENCHAMBER)/.test(key)));
  // OpenCode takes its directory from PWD, not from the process cwd: an
  // inherited PWD put every run in the real checkout.
  return { ...env, XDG_CONFIG_HOME: configHome, PWD: dir };
};

// A model's shell can still reach the real checkout. Any tool call whose input
// names it stops the whole bench. The checkout's own state is only reported:
// other sessions work in it too, so a change there is no proof against a model.
const repoMentions = [repo, repo.replace(os.homedir(), '~')];
const touchesRealRepo = (line) => {
  let ev;
  try { ev = JSON.parse(line); } catch { return false; }
  if (ev.type !== 'tool_use') return false;
  const input = JSON.stringify(ev.part?.state?.input ?? {});
  return repoMentions.some((mention) => input.includes(mention));
};
// The shell can still reach GitHub (`gh api`, `curl`). A run that asks the
// public repository for its own future is stopped and marked leaked.
const REMOTE_REPO = /github\.com\/[\w.-]+\/openchamber|githubusercontent\.com\/[\w.-]+\/openchamber|repos\/[\w.-]+\/openchamber|gh (api|pr|search|repo|browse)\b/i;
const leaksRemote = (line) => {
  let ev;
  try { ev = JSON.parse(line); } catch { return false; }
  return ev.type === 'tool_use' && REMOTE_REPO.test(JSON.stringify(ev.part?.state?.input ?? {}));
};
const realRepoState = () => must(`git -C ${repo} status --porcelain --untracked-files=all -- . ":!scripts/model-bench"`);
let repoBaseline = null;
let aborted = null;
const abortAll = (reason) => {
  if (aborted) return;
  aborted = reason;
  console.error(`ABORT: ${reason}`);
  for (const child of active) stopGroup(child);
};

// Processes a model left behind outside its group (`nohup`, `setsid`) still
// have their working directory inside the copy.
const killLeftovers = (dir) => {
  const out = sh('lsof -d cwd -Fpn 2>/dev/null').stdout;
  let pid = null;
  const victims = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid && pid !== process.pid && line.slice(1).startsWith(dir)) victims.push(pid);
  }
  for (const victim of victims) {
    try { process.kill(victim, 'SIGKILL'); } catch { /* gone */ }
  }
  return victims.length;
};

const runModel = (dir, model, prompt) => new Promise((resolve) => {
  const started = Date.now();
  const child = spawn('opencode', ['run', '--standalone', '--auto', '--format', 'json', '--agent', 'build', '-m', model, prompt], {
    cwd: dir,
    env: isolatedEnv(dir),
    detached: true,
    // An open stdin pipe makes `opencode run` wait for more message text and never start.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  active.add(child);
  const log = [];
  let buf = '';
  let lastEvent = Date.now();
  let stopReason = null;
  const stop = (reason) => {
    if (stopReason) return;
    stopReason = reason;
    stopGroup(child);
  };
  child.stdout.on('data', (d) => {
    lastEvent = Date.now();
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      log.push(line);
      if (touchesRealRepo(line)) abortAll(`${model} called a tool on the real checkout: ${line.slice(0, 300)}`);
      if (leaksRemote(line)) stop('leaked');
    }
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  const watchdog = setInterval(() => {
    const now = Date.now();
    if (now - started > RUN_TIMEOUT_MS) stop('timeout');
    else if (now - lastEvent > IDLE_TIMEOUT_MS) stop('idle');
  }, 5000);
  child.on('close', (code) => {
    clearInterval(watchdog);
    active.delete(child);
    if (buf.trim()) log.push(buf);
    resolve({ code, log, stderr, ms: Date.now() - started, stopReason: stopReason ?? (aborted ? 'aborted' : null) });
  });
});

const summarize = (log) => {
  const totals = { steps: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, cost: 0, tools: {}, sessionID: null };
  for (const line of log) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    totals.sessionID ??= ev.sessionID ?? null;
    if (ev.type === 'step_finish') {
      const t = ev.part?.tokens ?? {};
      totals.steps += 1;
      totals.input += t.input ?? 0;
      totals.output += t.output ?? 0;
      totals.reasoning += t.reasoning ?? 0;
      totals.cacheRead += t.cache?.read ?? 0;
      totals.cacheWrite += t.cache?.write ?? 0;
      totals.cost += ev.part?.cost ?? 0;
    }
    if (ev.type === 'tool_use') {
      const name = ev.part?.tool ?? 'unknown';
      totals.tools[name] = (totals.tools[name] ?? 0) + 1;
    }
  }
  return totals;
};

const run = async (task, model, { keep }) => {
  const slug = model.replace(/[^a-z0-9.-]+/gi, '_');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const runId = `${task.id}__${slug}__${stamp}`;
  const dir = path.join(cacheRoot, 'runs', runId);
  const out = path.join(cacheRoot, 'results', runId);
  const tag = `[${task.id}] ${model}`;
  console.log(`${tag}: preparing`);
  await prepare(task, dir);
  if (aborted) return null;
  console.log(`${tag}: running`);
  const result = await runModel(dir, model, task.prompt + PROMPT_SUFFIX);
  const leftovers = killLeftovers(dir);
  if (aborted) {
    const { sessionID } = summarize(result.log);
    if (sessionID) sh(`opencode session delete ${sessionID}`, { env: isolatedEnv(dir) });
    if (!keep) rmSync(dir, { recursive: true, force: true });
    return null;
  }

  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'events.jsonl'), `${result.log.join('\n')}\n`);
  if (result.stderr.trim()) writeFileSync(path.join(out, 'stderr.txt'), result.stderr);
  sh('git add -A', { cwd: dir });
  writeFileSync(path.join(out, 'model.patch'), sh('git diff --cached HEAD', { cwd: dir }).stdout);
  writeFileSync(path.join(out, 'reference.patch'), must(`git -C ${repo} diff ${task.commit}^ ${task.commit}`));
  writeFileSync(path.join(out, 'prompt.txt'), task.prompt);
  const changedFiles = sh('git diff --cached --name-only', { cwd: dir }).stdout.split('\n').filter(Boolean);
  const usage = summarize(result.log);
  // events.jsonl holds the whole run, so the session would only clutter the
  // user's session list.
  if (usage.sessionID) sh(`opencode session delete ${usage.sessionID}`, { env: isolatedEnv(dir) });
  if (usage.steps === 0) {
    // The model never answered: a harness or provider failure, not a result.
    console.log(`${tag}: NO RUN (exit ${result.code}, ${result.stopReason ?? 'no steps'}); see ${out}/stderr.txt`);
    if (!keep) rmSync(dir, { recursive: true, force: true });
    return null;
  }
  let tests = [];
  if (isReview(task)) {
    // The answer is the review: every text the model wrote, last one last.
    const texts = result.log.map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((ev) => ev?.type === 'text').map((ev) => ev.part.text);
    writeFileSync(path.join(out, 'answer.txt'), texts.join('\n\n---\n\n'));
    writeFileSync(path.join(out, 'reference.patch'), must(`git -C ${repo} show ${task.fixCommit}`));
  } else {
    applyHiddenTests(task, dir);
    tests = await runTests(task, dir);
    writeFileSync(path.join(out, 'tests.txt'), tests.map((t) => `--- ${t.cmd} (${t.pass ? 'pass' : 'fail'})\n${t.tail}`).join('\n'));
  }
  if (!keep) rmSync(dir, { recursive: true, force: true });

  const record = {
    at: new Date().toISOString(),
    task: task.id,
    type: task.type,
    level: task.level,
    commit: task.commit,
    model,
    exitCode: result.code,
    stopReason: result.stopReason,
    leaked: result.stopReason === 'leaked' || result.log.some(leaksRemote),
    minutes: Math.round(result.ms / 600) / 100,
    changedFiles,
    hiddenTestsPass: isReview(task) ? null : tests.every((t) => t.pass),
    testsAdvisory: Boolean(task.testsAdvisory),
    tests: tests.map(({ cmd, pass }) => ({ cmd, pass })),
    leftoverProcesses: leftovers,
    usage,
    out,
  };
  mkdirSync(benchHome, { recursive: true });
  appendFileSync(path.join(benchHome, 'results.jsonl'), `${JSON.stringify(record)}\n`);
  writeFileSync(path.join(out, 'record.json'), JSON.stringify(record, null, 2));
  const note = result.stopReason ? ` (stopped: ${result.stopReason})` : '';
  const verdict = isReview(task) ? 'REVIEWED' : record.hiddenTestsPass ? 'PASS' : 'FAIL';
  console.log(`${tag}: ${verdict}${note} in ${record.minutes} min, ${usage.steps} steps, files: ${changedFiles.join(', ') || 'none'}`);
  return record;
};

const runQueue = async (selected, models, { parallel, keep, repeat }) => {
  repoBaseline = realRepoState();
  const guard = setInterval(() => {
    const state = realRepoState();
    if (state === repoBaseline) return;
    const before = new Set(repoBaseline.split('\n'));
    const changed = state.split('\n').filter((entry) => entry && !before.has(entry));
    if (changed.length) console.log(`note: the real checkout changed (another session or a model): ${changed.join(', ')}`);
    repoBaseline = state;
  }, REPO_GUARD_INTERVAL_MS);
  // Task-major order spreads one provider's runs over time instead of firing
  // all of them at once. One run of a hard task can be luck, so level 3 tasks
  // run `repeat` times; each extra round queues after the whole first one.
  const queue = [];
  for (let round = 0; round < repeat; round += 1) {
    for (const task of selected) {
      if (round > 0 && task.level < 3) continue;
      for (const model of models) queue.push({ task, model });
    }
  }
  console.log(`${queue.length} runs, ${parallel} at a time`);
  const worker = async () => {
    while (queue.length && !aborted) {
      const { task, model } = queue.shift();
      try {
        await run(task, model, { keep });
      } catch (error) {
        console.error(`[${task.id}] ${model}: harness error: ${error.message.split('\n')[0]}`);
      }
    }
  };
  await Promise.all(Array.from({ length: parallel }, worker));
  clearInterval(guard);
  if (aborted) process.exit(2);
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    abortAll(`received ${signal}`);
    setTimeout(() => process.exit(130), 6000).unref();
  });
}

const usage = 'Usage: bench.mjs validate <task|all> | run <task|all> <provider/model[#variant]>... [--parallel N] [--timeout MIN] [--repeat N] [--keep]';
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return null;
  const [, value] = args.splice(i, name === '--keep' ? 1 : 2);
  return value ?? true;
};
const keep = Boolean(flag('--keep'));
const parallel = Number(flag('--parallel') ?? 4);
const repeat = Number(flag('--repeat') ?? 1);
const timeoutMinutes = flag('--timeout');
if (timeoutMinutes) RUN_TIMEOUT_MS = Number(timeoutMinutes) * 60 * 1000;
const [command, taskId, ...models] = args;
const selected = taskId ? pickTasks(taskId) : [];
if (!selected.length || !Number.isInteger(parallel) || parallel < 1) {
  console.error(usage);
  process.exit(1);
}
if (command === 'validate') {
  const results = [];
  for (const task of selected.filter((t) => !isReview(t))) results.push(await validate(task));
  process.exit(results.every(Boolean) ? 0 : 1);
} else if (command === 'run' && models.length) {
  await runQueue(selected, models, { parallel, keep, repeat });
} else {
  console.error(usage);
  process.exit(1);
}
