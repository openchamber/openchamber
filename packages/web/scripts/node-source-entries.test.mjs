import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const entries = [
  ['packages/web/bin/cli.js', 'packages/web/bin/cli-runtime.js', ['--version'], 0],
  ['packages/web/server/index.js', 'packages/web/server/runtime.js'],
  ['packages/web/server/lib/git/credential-helper.js', 'packages/web/server/lib/git/credential-helper-runtime.js', [], 0],
  ['packages/web/server/lib/git/repository-credential-helper.js', 'packages/web/server/lib/git/repository-credential-helper-runtime.js', [], 0],
  ['packages/web/server/lib/git/ssh-wrapper.js', 'packages/web/server/lib/git/ssh-wrapper-runtime.js', [], 1],
  ['packages/web/server/lib/dictation/local/worker-process.js', 'packages/web/server/lib/dictation/local/worker-runtime.js'],
  ['scripts/build-builtin-extensions.mjs', 'packages/web/server/lib/guests/builtins.js'],
  ['scripts/tool-use-bench/bench.mjs', 'packages/web/server/lib/injected-env.js', [], 0],
  ['scripts/release-mirror/mirror-to-r2.mjs', 'packages/web/server/lib/version-order.js'],
  ['packages/web/scripts/dev-server-watch.mjs', 'packages/web/server/lib/injected-env.js'],
];
const preloadedEntries = [
  'packages/web/server/lib/outbound-proxy.js',
  'packages/web/server/lib/github/auth.js',
  'packages/web/server/lib/source-control/auth-storage.js',
  'packages/web/server/lib/quota/providers/index.js',
  'packages/web/server/lib/opencode/providers.js',
  'packages/web/server/lib/dictation/local/model-downloader.js',
  'packages/web/server/lib/guests/service-registry.js',
];
const fixtures = [
  'packages/web/server/lib/git/storage-process.fixture.js',
  'packages/web/server/lib/source-control/storage-process.fixture.js',
];
let root;
let env;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-node-source-entries-'));
  for (const relative of ['packages/web/server', 'packages/web/bin', 'packages/web/scripts', 'scripts']) {
    fs.cpSync(path.join(repo, relative), path.join(root, relative), { recursive: true });
  }
  for (const relative of ['package.json', 'packages/web/package.json']) {
    fs.copyFileSync(path.join(repo, relative), path.join(root, relative));
  }
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  fs.symlinkSync(path.join(repo, 'packages/web/node_modules'), path.join(root, 'packages/web/node_modules'), 'junction');
  const sentinel = path.join(root, 'packages/web/server/node-entry-sentinel.ts');
  fs.writeFileSync(sentinel, 'const loaded: boolean = true; if (loaded) process.stderr.write("typescript-entry-loaded\\n");');
  for (const dependency of new Set([...entries.map(([, dependency]) => dependency), ...preloadedEntries, ...fixtures])) {
    const file = path.join(root, dependency);
    let relative = path.relative(path.dirname(file), sentinel).replaceAll(path.sep, '/').replace(/\.ts$/, '.js');
    if (!relative.startsWith('.')) relative = `./${relative}`;
    fs.writeFileSync(file, `import ${JSON.stringify(relative)};\n${fs.readFileSync(file, 'utf8')}`);
  }
  env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(NODE_OPTIONS$|OPENCHAMBER_|OPENCODE_|GIT_|XDG_)/.test(key)));
  Object.assign(env, { HOME: root, OPENCHAMBER_DATA_DIR: path.join(root, 'profile'), OPENCHAMBER_RELAY_HOST: 'off' });
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test.each(entries)('plain Node starts %s with a static TypeScript dependency', (entry, dependency, args, exitCode) => {
  const file = path.join(root, entry);
  const argv = args
    ? [file, ...args]
    : ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(file).href)}); process.exit(0);`];
  const result = spawnSync(process.execPath, argv, { env, encoding: 'utf8', input: '', timeout: 20_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(exitCode ?? 0);
  expect(result.stderr).toContain('typescript-entry-loaded');
}, 25_000);

test.each(preloadedEntries)('Node test consumers preload the source hook for %s', (entry) => {
  const result = spawnSync(process.execPath, [
    '--import', pathToFileURL(path.join(root, 'packages/web/scripts/register-server-sources.mjs')).href,
    '--input-type=module', '-e',
    `await import(${JSON.stringify(pathToFileURL(path.join(root, entry)).href)}); process.exit(0);`,
  ], { env, encoding: 'utf8', timeout: 20_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toContain('typescript-entry-loaded');
}, 25_000);

test.each(fixtures)('Node storage test forks preload the source hook for %s', async (entry) => {
  const child = fork(path.join(root, entry), [], {
    execArgv: ['--import', pathToFileURL(path.join(root, 'packages/web/scripts/register-server-sources.mjs')).href],
    env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(15_000) });
    expect(message).toEqual({ event: 'ready' });
  } finally {
    child.kill('SIGTERM');
    await exited;
  }
  expect(stderr).toContain('typescript-entry-loaded');
}, 20_000);

test('importing the CLI preserves every compatibility export without dispatching', () => {
  const entry = pathToFileURL(path.join(root, 'packages/web/bin/cli.js')).href;
  const runtime = pathToFileURL(path.join(root, 'packages/web/bin/cli-runtime.js')).href;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const entry = await import(${JSON.stringify(entry)});
    const runtime = await import(${JSON.stringify(runtime)});
    for (const key of Object.keys(runtime)) {
      if (entry[key] !== runtime[key]) throw new Error('Changed CLI export: ' + key);
    }
    console.log(JSON.stringify(Object.keys(entry).sort()));
  `], { env, encoding: 'utf8', timeout: 20_000 });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toContain('main');
}, 25_000);

test.skipIf(process.platform === 'win32')('the executable CLI and its openchamber symlink retain shebang dispatch', () => {
  const entry = path.join(root, 'packages/web/bin/cli.js');
  const link = path.join(root, 'openchamber');
  fs.symlinkSync(entry, link);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'packages/web/package.json'), 'utf8')).version;
  for (const executable of [entry, link]) {
    const result = spawnSync(executable, ['--version'], { env, encoding: 'utf8', timeout: 20_000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  }
}, 25_000);

test('plain Node forks the dictation entry and disconnects without loading a speech model', async () => {
  const child = fork(path.join(root, 'packages/web/server/lib/dictation/local/worker-process.js'), [], {
    execArgv: [], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    child.send({ type: 'session.clear', sessionId: 'absent', requestId: 'startup' });
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(15_000) });
    expect(message).toEqual({ type: 'response', requestId: 'startup', ok: true });
    expect(stderr).toContain('typescript-entry-loaded');
    child.disconnect();
    const [code] = await exited;
    expect(code).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
  }
}, 20_000);
