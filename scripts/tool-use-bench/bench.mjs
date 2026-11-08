#!/usr/bin/env node
// Tool-use bench: does an agent reach OpenChamber's own tools when it should?
// Each model gets its own isolated OpenChamber server with two large stand-in
// MCP servers, so the Code Mode catalog is as crowded as in a real session.
// See README.md.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withoutInjectedEnv } from '../../packages/web/server/lib/injected-env.js';

const BENCH_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCH_DIR, '../..');
const CASES = JSON.parse(fs.readFileSync(path.join(BENCH_DIR, 'cases.json'), 'utf8'));
const REAL_OPENCODE_DB = path.join(os.homedir(), '.local/share/opencode/opencode.db');
const OPENCODE_BINARY = process.env.OPENCODE_BINARY ?? '/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode';
const OPENCHAMBER_TOOL = /^openchamber(_|$)/;
const STALL_MS = 120_000;

// The shell running the bench may belong to an OpenChamber session, and its
// OpenCode and OpenChamber variables can point the instance at a real server
// (OPENCODE_HOST, OPENCODE_PORT, skip-start) or its passwords. Git variables
// such as GIT_DIR would point git at a real repository. None of them pass.
// CLAUDE_CONFIG_DIR would send Claude Agent's Claude Code to a real config folder.
const isolatedEnv = (base) => Object.fromEntries(Object.entries(base)
  .filter(([key]) => key !== 'OPENCODE' && key !== 'CLAUDE_CONFIG_DIR' && !/^(OPENCODE|OPENCHAMBER|GIT)_/.test(key)));
const GIT_ENV = isolatedEnv(process.env);
const git = (directory, args, options = {}) => spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', env: GIT_ENV, ...options });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

// ---------------------------------------------------------------- arguments

const parseArgs = (argv) => {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument ${key}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith('--')) options[key.slice(2)] = true;
    else { options[key.slice(2)] = value; index += 1; }
  }
  return { command, options };
};

const parseModel = (text) => {
  const [ref, variant] = text.split('#');
  const slash = ref.indexOf('/');
  if (slash < 1) throw new Error(`Model ${text} is not provider/model`);
  return { providerID: ref.slice(0, slash), id: ref.slice(slash + 1), ...(variant ? { variant } : {}), label: text };
};

// ---------------------------------------------------------------- instance

const writeProject = (directory) => {
  fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'README.md'), '# demo\n\nA tiny library that formats prices.\n\n## Usage\n\n```js\nimport { formatPrice } from "./src/index.js";\nformatPrice(1999); // "$19.99"\n```\n');
  fs.writeFileSync(path.join(directory, 'package.json'), `${JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' }, devDependencies: { typescript: '^5.4.0' } }, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, 'src/index.js'), 'export function formatPrice(cents) {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n');
  fs.writeFileSync(path.join(directory, 'src/index.test.js'), 'import test from "node:test";\nimport assert from "node:assert";\nimport { formatPrice } from "./index.js";\n\ntest("formats cents", () => {\n  assert.strictEqual(formatPrice(1999), "$19.99");\n});\n');
  const run = (...args) => git(directory, ['-c', 'user.email=bench@example.com', '-c', 'user.name=bench', ...args], { stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  run('add', '.');
  run('commit', '-qm', 'Initial commit');
  const head = git(directory, ['rev-parse', 'HEAD']);
  if (head.status !== 0) throw new Error(`git setup failed in ${directory}: ${head.stderr}`);
  return head.stdout.trim();
};

const writeOpenCodeConfig = (directory) => {
  const fake = path.join(BENCH_DIR, 'fake-mcp.mjs');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'opencode.json'), JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    mcp: {
      cloud: { type: 'local', command: ['node', fake, '3000', 'cloud'] },
      tracker: { type: 'local', command: ['node', fake, '60', 'tracker'] },
    },
  }, null, 2));
};

const listFiles = (root, skip) => {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (skip(full)) continue;
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return files;
};

// `instances` gets the instance before anything can fail, so the one cleanup
// path stops its server and deletes its folder, credential copies included.
const createInstance = async ({ mode, apiPort, models, instances }) => {
  const providers = [...new Set(models.map((model) => model.providerID))];
  const apiBase = `http://localhost:${apiPort}`;
  if (await fetch(apiBase).then(() => true, () => false)) throw new Error(`Port ${apiPort} is taken; pass another --port`);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tool-use-bench-${mode}-`)));
  const instance = { mode, root, apiBase, pgid: null, baseline: new Map(), projectId: null };
  instances.push(instance);
  const dirs = Object.fromEntries(['proj', 'home', 'xdg', 'data', 'cache', 'state', 'oc'].map((name) => [name, path.join(root, name)]));
  instance.dirs = dirs;
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { recursive: true });
  instance.initialCommit = writeProject(dirs.proj);
  writeOpenCodeConfig(path.join(dirs.xdg, 'opencode'));
  fs.writeFileSync(path.join(dirs.oc, 'settings.json'), JSON.stringify({
    projects: [{ id: 'bench', path: dirs.proj, addedAt: 1 }],
    activeProjectId: 'bench',
    agentControlToolEnabled: true,
    agentScheduleToolEnabled: true,
    agentWebToolEnabled: true,
    agentMemoryToolEnabled: true,
    agentKnowledgeToolEnabled: true,
    agentNotifyToolEnabled: true,
    agentRenderToolEnabled: true,
    agentSecretToolEnabled: true,
    agentWorkflowToolEnabled: true,
  }, null, 2));

  if (providers.includes('claude-agent')) writeClaudeLogin(dirs.home);
  const env = isolatedEnv(withoutInjectedEnv(process.env));
  Object.assign(env, {
    HOME: dirs.home,
    BUN_INSTALL_CACHE_DIR: dirs.cache,
    XDG_CONFIG_HOME: dirs.xdg,
    XDG_DATA_HOME: dirs.data,
    XDG_CACHE_HOME: dirs.cache,
    XDG_STATE_HOME: dirs.state,
    OPENCHAMBER_DATA_DIR: dirs.oc,
    OPENCODE_BINARY,
    OPENCHAMBER_RELAY_HOST: 'off',
  });
  // The API server alone: the bench needs no UI, and `bun run dev` instances
  // started side by side clear each other's Vite cache in the repository.
  const logFile = fs.openSync(path.join(root, 'server.log'), 'a');
  const start = () => {
    instance.pgid = spawn('bun', ['server/index.js', '--port', String(apiPort)], { cwd: path.join(REPO_ROOT, 'packages/web'), env, detached: true, stdio: ['ignore', logFile, logFile] }).pid;
  };
  start();
  await waitForApi(instance);
  // OpenCode creates its database on first start, and provider plugins (the
  // ChatGPT sign-in among them) read credentials only when they start: copy
  // them into the fresh database, then start again.
  await copyCredentials(instance, providers);
  await stopAndWait(instance);
  await waitForPortFree(apiBase);
  start();
  await waitForApi(instance);
  await waitForModels(instance, models);
  const settings = await api(instance, 'GET', '/api/config/settings');
  instance.projectId = settings.projects?.find((project) => project.path === dirs.proj)?.id;
  if (!instance.projectId) throw new Error(`${mode}: the demo project is not registered`);
  // What the data folder holds once the server has started, to return to before every run.
  for (const file of listFiles(dirs.oc, (full) => full.startsWith(path.join(dirs.oc, 'run')))) {
    instance.baseline.set(file, fs.readFileSync(file));
  }
  log(`${mode}: instance ready at ${instance.apiBase} (${root})`);
  return instance;
};

const waitForPortFree = async (apiBase) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (!(await fetch(apiBase).then(() => true, () => false))) return;
    await sleep(1000);
  }
  throw new Error(`${apiBase} did not stop`);
};

// Claude Agent runs the user's Claude Code, which finds its login through the
// account in ~/.claude.json and the token in the macOS login keychain. The
// isolated HOME gets only the account fields, none of the user's projects or
// servers, and a link to the keychain folder, which `security` looks up under
// $HOME. Deleting the folder removes the link, never the keychains.
const writeClaudeLogin = (home) => {
  const real = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  const login = Object.fromEntries(['oauthAccount', 'userID', 'hasCompletedOnboarding'].filter((key) => key in real).map((key) => [key, real[key]]));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(login), { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'Library'), { recursive: true });
  fs.symlinkSync(path.join(os.homedir(), 'Library/Keychains'), path.join(home, 'Library/Keychains'));
};

const api = async (instance, method, route, body) => {
  const response = await fetch(`${instance.apiBase}${route}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-opencode-directory': encodeURIComponent(instance.dirs.proj) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

const waitForApi = async (instance) => {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      const sessions = await api(instance, 'GET', `/api/session?directory=${encodeURIComponent(REPO_ROOT)}`);
      // A list with sessions means the instance reads real data: stop before writing anything.
      if ((sessions.data ?? []).length > 0) throw new Error('The instance sees real sessions; isolation failed');
      return;
    } catch (error) {
      if (String(error.message).includes('isolation failed')) throw error;
      await sleep(2000);
    }
  }
  throw new Error(`${instance.mode}: the API did not start; see ${instance.root}/server.log`);
};

// OpenCode 2 keeps provider credentials in its database. The isolated one gets
// copies of the rows for the providers under test, and the whole folder is
// deleted when the run ends.
const copyCredentials = async (instance, providers) => {
  const database = path.join(instance.dirs.data, 'opencode/opencode.db');
  const list = providers.map((provider) => `'${provider.replaceAll("'", '')}'`).join(',');
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const result = spawnSync('sqlite3', [database, `attach '${REAL_OPENCODE_DB}' as real; insert or ignore into credential select * from real.credential where integration_id in (${list});`], { encoding: 'utf8' });
    if (result.status === 0) return;
    await sleep(2000);
  }
  throw new Error(`${instance.mode}: could not copy provider credentials`);
};

// A provider can be listed before its models are: Claude Agent learns them
// from Claude Code a few seconds later, and a prompt sent before that fails
// with "Model unavailable".
const waitForModels = async (instance, models) => {
  const wanted = models.map((model) => `${model.providerID}/${model.id}`);
  let missing = wanted;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const response = await api(instance, 'GET', '/api/model');
    const known = new Set((response.data ?? []).map((model) => `${model.providerID}/${model.modelID}`));
    missing = wanted.filter((model) => !known.has(model));
    if (missing.length === 0) return;
    await sleep(2000);
  }
  throw new Error(`${instance.mode}: models ${missing.join(', ')} did not become available`);
};

const stopInstance = (instance) => {
  if (instance.pgid) try { process.kill(-instance.pgid, 'SIGTERM'); } catch {}
};

const groupAlive = (pgid) => {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
};

// The server stops its OpenCode on SIGTERM; a group still alive after that
// gets SIGKILL, and only then is the folder touched.
const stopAndWait = async (instance) => {
  if (!instance.pgid) return;
  stopInstance(instance);
  for (let attempt = 0; attempt < 20 && groupAlive(instance.pgid); attempt += 1) await sleep(500);
  if (groupAlive(instance.pgid)) try { process.kill(-instance.pgid, 'SIGKILL'); } catch {}
};

// --keep leaves the folder for inspection, without the copied credentials.
const scrubCredentials = (instance) => {
  const database = path.join(instance.dirs.data, 'opencode/opencode.db');
  if (!fs.existsSync(database)) return true;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (spawnSync('sqlite3', [database, 'delete from credential;']).status === 0) return true;
    spawnSync('sleep', ['1']);
  }
  return false;
};

// ---------------------------------------------------------------- one run

const listSessions = async (instance) => (await api(instance, 'GET', `/api/session?directory=${encodeURIComponent(instance.dirs.proj)}`)).data ?? [];

const interruptAll = async (instance) => {
  for (const session of await listSessions(instance)) {
    await api(instance, 'POST', `/api/session/${session.id}/interrupt`).catch(() => undefined);
  }
};

// Each run starts from the same state: no memory, todos or schedules the
// previous run saved, and a clean checkout with no extra worktrees or branches.
const resetState = async (instance) => {
  await interruptAll(instance);
  // The scheduler keeps tasks in a project file it also writes at startup, so
  // tasks go through its API rather than a file restore.
  const { tasks = [] } = await api(instance, 'GET', `/api/projects/${encodeURIComponent(instance.projectId)}/scheduled-tasks`);
  for (const task of tasks) await api(instance, 'DELETE', `/api/projects/${encodeURIComponent(instance.projectId)}/scheduled-tasks/${encodeURIComponent(task.id)}`);
  const runDirectory = path.join(instance.dirs.oc, 'run');
  for (const file of listFiles(instance.dirs.oc, (full) => full.startsWith(runDirectory))) {
    const original = instance.baseline.get(file);
    if (!original) fs.rmSync(file, { force: true });
    else if (!original.equals(fs.readFileSync(file))) fs.writeFileSync(file, original);
  }
  const run = (...args) => git(instance.dirs.proj, args);
  const worktrees = run('worktree', 'list', '--porcelain').stdout.split('\n')
    .filter((line) => line.startsWith('worktree ')).map((line) => line.slice('worktree '.length))
    .filter((worktree) => worktree !== instance.dirs.proj);
  for (const worktree of worktrees) run('worktree', 'remove', '--force', worktree);
  run('worktree', 'prune');
  // To the initial commit, so a commit an agent made on main does not carry over.
  run('checkout', '-q', '-f', 'main');
  if (run('reset', '-q', '--hard', instance.initialCommit).status !== 0) throw new Error(`${instance.mode}: could not reset the demo project`);
  run('clean', '-qfdx');
  for (const branch of run('for-each-ref', '--format=%(refname:short)', 'refs/heads').stdout.split('\n').filter(Boolean)) {
    if (branch !== 'main') run('branch', '-q', '-D', branch);
  }
};

// A question, a page waiting for an answer, or a secret request.
const waitsForUser = (part) => {
  if (part.type !== 'tool' || part.state?.status !== 'running') return false;
  if (part.name === 'question' || part.name === 'openchamber_secret') return true;
  if (part.name !== 'openchamber_render') return false;
  const input = part.state?.input ?? {};
  return input.awaitAnswer === true || input.parameters?.awaitAnswer === true;
};

const readMessages = async (instance, sessionId) => (await api(instance, 'GET', `/api/session/${sessionId}/message?limit=200`)).data ?? [];

const runOnce = async (instance, testCase, model, timeoutMs) => {
  await resetState(instance);
  const created = await api(instance, 'POST', '/api/session', {
    title: `bench ${testCase.id}`,
    location: { directory: instance.dirs.proj },
    model: { providerID: model.providerID, id: model.id, ...(model.variant ? { variant: model.variant } : {}) },
  });
  const sessionId = created.data.id;
  // Without the sync the session has none of the guidance a real session gets.
  await api(instance, 'POST', '/api/session-knowledge/sync', { sessionId, directory: instance.dirs.proj });
  const startedAt = Date.now();
  await api(instance, 'POST', `/api/session/${sessionId}/prompt`, { text: testCase.prompt });

  let messages = [];
  let stop = 'timeout';
  let snapshot = '';
  let changedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await sleep(3000);
    messages = await readMessages(instance, sessionId);
    const latest = messages[0];
    if (latest?.type === 'idle') {
      stop = latest.outcome === 'succeeded' ? 'done' : `idle:${latest.outcome}${latest.error ? `:${latest.error.message}` : ''}`;
      break;
    }
    // An agent that asks the user something has ended its turn as far as the
    // bench goes: nobody answers, and its calls so far are what gets graded.
    if (messages.some((message) => message.content?.some(waitsForUser))) {
      stop = 'asked';
      break;
    }
    // A provider stream that goes silent (seen with a tool call stuck in
    // "streaming") says nothing about the tools; such a run is left out.
    const current = JSON.stringify(messages);
    if (current !== snapshot) { snapshot = current; changedAt = Date.now(); }
    else if (Date.now() - changedAt > STALL_MS) { stop = 'stalled'; break; }
  }
  // Sessions the agent dispatched keep working otherwise, on the bench's bill.
  await interruptAll(instance);
  return { sessionId, stop, durationMs: Date.now() - startedAt, messages: [...messages].reverse() };
};

// ---------------------------------------------------------------- grading

const parseResult = (part) => {
  const text = part.state?.content?.find((item) => item.type === 'text')?.text;
  if (!text) return undefined;
  try { return JSON.parse(text); } catch { return undefined; }
};

// Behind Code Mode most of our tools sit in the `openchamber` namespace, so a
// call names `openchamber.web`; cases name the ids (`openchamber_web`).
const canonicalTool = (tool) => String(tool ?? '').replaceAll('.', '_');

/** Every tool call of the run, with Code Mode's inner calls unpacked. */
const collectCalls = (messages) => {
  const calls = [];
  for (const message of messages) {
    for (const part of message.content ?? []) {
      if (part.type !== 'tool') continue;
      if (part.name === 'execute') {
        const inner = part.state?.metadata?.toolCalls ?? [];
        calls.push({ tool: 'execute', status: part.state?.status, code: part.state?.input?.code, innerCount: inner.length });
        for (const call of inner) calls.push({ tool: canonicalTool(call.tool), input: call.input ?? {}, status: call.status, viaExecute: true });
        continue;
      }
      const result = parseResult(part);
      calls.push({ tool: part.name, input: part.state?.input ?? {}, status: part.state?.status, ...(result && typeof result.ok === 'boolean' ? { ok: result.ok } : {}) });
    }
  }
  return calls;
};

// Models also send an object input as JSON text, and the plugin parses it.
const asObject = (value) => {
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return value;
  try { return JSON.parse(value); } catch { return value; }
};
const readPath = (object, dotted) => dotted.split('.').reduce((value, key) => (value == null ? undefined : asObject(value)[key]), object);

const argMatches = (actual, expected) => {
  if (typeof expected === 'string' && expected.startsWith('~')) return typeof actual === 'string' && actual.toLowerCase().includes(expected.slice(1).toLowerCase());
  return actual === expected;
};

// Models send inputs inside `parameters` or beside `action`, and the plugin
// accepts both, so a check reads either.
const callMatches = (call, expected) => {
  if (expected.toolIncludes) return call.tool?.includes(expected.toolIncludes);
  if (call.tool !== expected.tool) return false;
  const action = String(call.input?.action ?? '');
  // A tool with one action (notify) takes a call without `action`; the plugin's answer says whether it went through.
  const actionMatches = action === '' ? call.ok !== false : action.startsWith(expected.action) || expected.action.endsWith(`.${action}`);
  if (expected.action && !actionMatches) return false;
  const parameters = { ...call.input, ...(typeof call.input?.parameters === 'object' ? call.input.parameters : {}) };
  return Object.entries(expected.args ?? {}).every(([key, value]) => argMatches(readPath(parameters, key), value));
};

const grade = (testCase, calls) => {
  const ours = calls.filter((call) => OPENCHAMBER_TOOL.test(call.tool ?? ''));
  if (testCase.expect.noOpenChamberCalls) return { pass: ours.length === 0, missing: [] };
  const missing = testCase.expect.calls.filter((expected) => !calls.some((call) => callMatches(call, expected)));
  return { pass: missing.length === 0, missing };
};

const summarizeRun = (messages) => {
  const assistant = messages.filter((message) => message.type === 'assistant');
  const total = assistant.reduce((sum, message) => ({
    input: sum.input + (message.tokens?.input ?? 0) + (message.tokens?.cache?.read ?? 0) + (message.tokens?.cache?.write ?? 0),
    output: sum.output + (message.tokens?.output ?? 0) + (message.tokens?.reasoning ?? 0),
    cost: sum.cost + (message.cost ?? 0),
  }), { input: 0, output: 0, cost: 0 });
  const first = assistant[0]?.tokens;
  return {
    steps: assistant.length,
    // The first request's prompt: system prompt, guidance and the tool list, the cost every turn starts from.
    firstInput: first ? (first.input ?? 0) + (first.cache?.read ?? 0) + (first.cache?.write ?? 0) : null,
    ...total,
    finalText: assistant.at(-1)?.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? '',
  };
};

// A run the provider broke says nothing about the tools: an empty call list
// would pass a control case and fail every other one. It counts as an error.
const runError = (stop) => {
  if (stop === 'stalled') return { error: 'stalled: the provider stream went silent' };
  if (stop.startsWith('idle:')) return { error: stop };
  return {};
};

// ---------------------------------------------------------------- commands

const run = async (options) => {
  if (!options.models) throw new Error('--models provider/model[#variant],... is required');
  const models = String(options.models).split(',').map(parseModel);
  // OpenChamber puts its tools behind Code Mode with no setting for it; the
  // label stays in results so runs from before compare in one report.
  const modes = ['codemode'];
  const caseIds = options.case ? new Set(String(options.case).split(',')) : null;
  const cases = CASES.filter((testCase) => !caseIds || caseIds.has(testCase.id));
  if (cases.length === 0) throw new Error('No case matches --case');
  const samples = Number.parseInt(options.samples ?? '2', 10);
  const timeoutMs = Number.parseInt(options.timeout ?? '300', 10) * 1000;
  const out = path.resolve(options.out ?? path.join(os.homedir(), '.cache/openchamber-tool-use-bench', new Date().toISOString().replaceAll(':', '-')));
  fs.mkdirSync(path.join(out, 'transcripts'), { recursive: true });
  const resultsFile = path.join(out, 'results.jsonl');
  const basePort = Number.parseInt(options.port ?? '47300', 10);
  log(`${cases.length} cases x ${models.length} models x ${modes.length} modes x ${samples} samples -> ${out}`);

  const instances = [];
  // One cleanup for every ending: done, failed or interrupted. A kept folder
  // still loses its copied credentials.
  const cleanup = async () => {
    const stopping = instances.splice(0);
    await Promise.all(stopping.map(stopAndWait));
    for (const instance of stopping) {
      if (!options.keep) fs.rmSync(instance.root, { recursive: true, force: true });
      else if (instance.dirs && !scrubCredentials(instance)) console.error(`Copied credentials are still in ${instance.dirs.data}; delete that folder`);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => { cleanup().finally(() => process.exit(1)); });
  try {
    // Instances start one after another: each dev start rebuilds the built-in
    // extensions inside the repository, and two at once collide there.
    const lanes = models.flatMap((model) => modes.map((mode) => ({ model, mode })));
    for (const [index, lane] of lanes.entries()) {
      lane.instance = await createInstance({ mode: lane.mode, apiPort: basePort + index, models: [lane.model], instances });
    }
    // One instance per model and mode, all side by side; runs inside an
    // instance go one at a time, because memory and todos one run saves would
    // show in the next.
    await Promise.all(lanes.map(async ({ model, mode, instance }) => {
      for (const testCase of cases) {
        for (let sample = 1; sample <= samples; sample += 1) {
          let record;
          try {
            const result = await runOnce(instance, testCase, model, timeoutMs);
            const calls = collectCalls(result.messages);
            const graded = grade(testCase, calls);
            const transcript = path.join(out, 'transcripts', `${mode}__${model.label.replaceAll('/', '_')}__${testCase.id}__${sample}.json`);
            fs.writeFileSync(transcript, JSON.stringify({ case: testCase, mode, model: model.label, ...result, calls }, null, 2));
            record = { mode, model: model.label, case: testCase.id, kind: testCase.kind, sample, stop: result.stop, durationMs: result.durationMs, ...graded, calls: calls.map(({ tool, input, status, ok, viaExecute }) => ({ tool, action: input?.action, status, ok, viaExecute })), ...summarizeRun(result.messages), transcript, ...runError(result.stop) };
          } catch (error) {
            record = { mode, model: model.label, case: testCase.id, kind: testCase.kind, sample, error: String(error.message ?? error) };
          }
          fs.appendFileSync(resultsFile, `${JSON.stringify(record)}\n`);
          log(`${mode} ${model.label} ${testCase.id}#${sample}: ${record.error ? `error ${record.error}` : `${record.pass ? 'pass' : 'FAIL'} (${record.stop}, ${record.steps} steps, first prompt ${record.firstInput} tokens)`}`);
        }
      }
    }));
  } finally {
    await cleanup();
  }
  report({ _: out });
  console.log(`\nResults: ${resultsFile}`);
};

const report = (options) => {
  const out = path.resolve(options._ ?? options.out);
  const records = fs.readFileSync(path.join(out, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const columns = [...new Set(records.map((record) => `${record.mode} ${record.model}`))];
  const cases = [...new Set(records.map((record) => record.case))];
  const cell = (caseId, column) => {
    const runs = records.filter((record) => record.case === caseId && `${record.mode} ${record.model}` === column);
    const graded = runs.filter((record) => !record.error);
    const errors = runs.length - graded.length;
    return `${graded.filter((record) => record.pass).length}/${graded.length}${errors ? ` (+${errors} err)` : ''}`;
  };
  const rows = [['case', ...columns], ...cases.map((caseId) => [caseId, ...columns.map((column) => cell(caseId, column))])];
  const average = (values) => (values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : '-');
  const graded = (column) => records.filter((record) => !record.error && `${record.mode} ${record.model}` === column);
  rows.push(['first prompt, tokens', ...columns.map((column) => String(average(graded(column).map((record) => record.firstInput).filter(Number.isFinite))))]);
  rows.push(['steps per run', ...columns.map((column) => String(average(graded(column).map((record) => record.steps))))]);
  rows.push(['input tokens per run', ...columns.map((column) => String(average(graded(column).map((record) => record.input))))]);
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => String(row[index]).length)));
  for (const row of rows) console.log(row.map((value, index) => String(value).padEnd(widths[index])).join('  '));
};

// Grades the saved transcripts again with the current cases and grader, so a
// grading fix needs no new model calls.
const regrade = (out) => {
  const resultsFile = path.join(path.resolve(out), 'results.jsonl');
  const cases = new Map(CASES.map((testCase) => [testCase.id, testCase]));
  const records = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).map((record) => {
    if (!record.transcript || !fs.existsSync(record.transcript)) return record;
    const { calls } = JSON.parse(fs.readFileSync(record.transcript, 'utf8'));
    return { ...record, ...grade(cases.get(record.case), calls) };
  });
  fs.copyFileSync(resultsFile, `${resultsFile}.before-regrade`);
  fs.writeFileSync(resultsFile, records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  report({ _: out });
};

const command = process.argv[2];
if (command === 'run') await run(parseArgs(process.argv.slice(2)).options);
else if (command === 'report' && process.argv[3]) report({ _: process.argv[3] });
else if (command === 'regrade' && process.argv[3]) regrade(process.argv[3]);
else {
  console.log('Usage:\n  node scripts/tool-use-bench/bench.mjs run --models provider/model[#variant],... [--case id,...] [--samples 2] [--timeout 300] [--out dir] [--port 47300] [--keep]\n  node scripts/tool-use-bench/bench.mjs report <out-dir>\n  node scripts/tool-use-bench/bench.mjs regrade <out-dir>');
  process.exitCode = command ? 1 : 0;
}
