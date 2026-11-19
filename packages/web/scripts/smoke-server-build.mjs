import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceCli = process.argv.includes('--source-cli');
const builtCli = process.argv.includes('--built-cli');
const label = sourceCli ? 'Node source CLI' : builtCli ? 'Node built CLI' : 'Node built entry';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-built-server-'));
const listener = net.createServer();
await new Promise((resolve, reject) => listener.once('error', reject).listen(0, 'localhost', resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OPENCHAMBER_|OPENCODE_|XDG_|GIT_|NODE_OPTIONS$)/.test(name)));
for (const folder of ['home', 'config', 'data', 'cache', 'state', 'openchamber']) fs.mkdirSync(path.join(root, folder));
Object.assign(env, {
  HOME: path.join(root, 'home'),
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_CACHE_HOME: path.join(root, 'cache'),
  XDG_STATE_HOME: path.join(root, 'state'),
  OPENCHAMBER_DATA_DIR: path.join(root, 'openchamber'),
  OPENCHAMBER_RELAY_HOST: 'off',
  OPENCODE_HOST: 'http://localhost:9',
  OPENCODE_SKIP_START: 'true',
});
if (sourceCli || builtCli) Object.assign(env, { BUN_BINARY: path.join(root, 'bun-not-installed'), OPENCODE_BINARY: process.execPath });
const log = fs.openSync(path.join(root, 'server.log'), 'w');
const args = sourceCli
  ? [path.join(webRoot, 'bin/cli.js'), 'serve', '--foreground', '--api-only']
  : builtCli
    ? [path.join(webRoot, 'build/bin/cli.js'), 'serve', '--foreground']
    : [path.join(webRoot, 'build/server/index.js')];
const child = spawn(process.execPath, [...args, '--host', 'localhost', '--port', String(port)], {
  cwd: webRoot, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', log, log],
});
const exited = new Promise((resolve) => {
  child.once('error', (error) => resolve(error));
  child.once('exit', (code, signal) => resolve({ code, signal }));
});
try {
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(fs.readFileSync(path.join(root, 'server.log'), 'utf8'));
    try {
      const response = await fetch(`http://localhost:${port}/health`, { signal: AbortSignal.timeout(1_000) });
      const health = await response.json();
      if (response.ok && health.status === 'ok') {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  if (!ready) throw new Error(`Built Node entry did not answer:\n${fs.readFileSync(path.join(root, 'server.log'), 'utf8')}`);
  for (const route of [...(sourceCli ? [] : ['/']), '/api/diagnostics/local-files', '/api/diagnostics/opencode-load']) {
    const response = await fetch(`http://localhost:${port}${route}`, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`${route}: HTTP ${response.status}`);
    if (route === '/') {
      if (!(await response.text()).toLowerCase().includes('<!doctype html')) throw new Error('UI response is not HTML');
    } else {
      const result = await response.json();
      if (route.endsWith('local-files') && (!Array.isArray(result.events) || !Array.isArray(result.coverage))) throw new Error('Invalid diagnostic snapshot');
      if (route.endsWith('opencode-load') && (result.locations !== null || result.processes !== null)) throw new Error('Unavailable OpenCode must remain unknown');
    }
    console.log(`${label} ${route}: 200`);
  }
  console.log(`${label} /health: 200; port=${port}; pid=${child.pid}`);
} finally {
  child.kill('SIGTERM');
  const abort = new AbortController();
  const stopped = await Promise.race([exited, delay(35_000, false, { signal: abort.signal })]);
  abort.abort();
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, stopped ? 'SIGTERM' : 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  } else if (!stopped) child.kill('SIGKILL');
  await exited;
  fs.closeSync(log);
  fs.rmSync(root, { recursive: true, force: true });
  console.log('Server stopped; isolated data removed.');
}
