import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { botGit } from './production-git.js';

// Executes the real index.js in separate host and child processes. Only the
// OpenCode network peer is controlled; no provider or personal credential is used.
const root = await fs.mkdtemp('/tmp/opencode/bots-host-process-');
const repository = path.join(root, 'repository');
const children = new Set();
const streams = new Set();
await fs.mkdir(repository);
await botGit(repository, ['init', '--quiet', '--initial-branch=main']);
await botGit(repository, ['-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'Fixture']);
await botGit(repository, ['remote', 'add', 'origin', 'https://github.com/fixture/repository.git']);
const upstream = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://opencode.test');
  if (url.pathname === '/api/event') {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n');
    streams.add(res); res.on('close', () => streams.delete(res)); return;
  }
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/api/info') return res.end(JSON.stringify({ version: '2.2.5' }));
  if (url.pathname === '/api/session/active') return res.end(JSON.stringify({ data: {} }));
  if (url.pathname === '/api/session') return res.end(JSON.stringify({ data: [], cursor: {} }));
  if (url.pathname === '/api/model/default') return res.end(JSON.stringify({ data: { providerID: 'fixture', id: 'model' } }));
  return res.end(JSON.stringify({ data: [] }));
});
await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;
const launch = async (inside) => {
  const home = path.join(root, inside ? 'child' : 'host');
  const dataDir = path.join(home, '.config', 'openchamber');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ projects: [{ id: 'project', path: repository, name: 'Fixture' }], lastDirectory: repository,
    nativeNotificationsEnabled: false, notifyOnCompletion: false }));
  const source = `import {startWebUiServer} from ${JSON.stringify(new URL('../../index.js', import.meta.url).href)};
const server=await startWebUiServer({port:0,host:'127.0.0.1',apiOnly:true,uiPassword:'fixture-pass',attachSignals:false});
process.send({type:'driver:ready',port:server.getPort()});
process.on('message',async message=>{if(message==='stop'){await server.stop();process.exit(0);}});`;
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local', 'share'),
      CI: 'true', GIT_MASTER: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      OPENCHAMBER_DATA_DIR: dataDir, OPENCHAMBER_RELAY_HOST: 'off', OPENCODE_HOST: upstreamUrl, OPENCODE_PORT: String(upstream.address().port), OPENCODE_SKIP_START: 'true',
  };
  if (inside) env.OPENCHAMBER_SPACE_IDLE_STOP_FILE = path.join(home, 'idle.json');
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { cwd: path.resolve(new URL('../../../..', import.meta.url).pathname), env,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true });
  children.add(child);
  let output = '';
  child.stdout.on('data', (chunk) => { output = (output + chunk).slice(-20_000); });
  child.stderr.on('data', (chunk) => { output = (output + chunk).slice(-20_000); });
  const ready = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out\n${output}`)), 60_000);
    child.on('message', (message) => { if (message.type === 'driver:ready') { clearTimeout(timeout); resolve(message); } });
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Server exited ${code}\n${output}`)); });
  });
  const { port } = await ready;
  const baseUrl = `http://127.0.0.1:${port}`;
  const login = await fetch(`${baseUrl}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'fixture-pass' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (route, method = 'GET', body) => {
    const options = { method, headers: { cookie } };
    if (body) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(baseUrl + route, options);
    return { status: response.status, body: await response.json() };
  };
  return { child, baseUrl, cookie, request, dataDir, logs: () => output, async close() {
    const ended = once(child, 'exit'); child.send('stop');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const [code] = await ended; clearTimeout(timeout); children.delete(child);
    assert.equal(code, 0, output);
  } };
};

try {
  const host = await launch(false);
  const eventsAbort = new AbortController();
  const response = await fetch(`${host.baseUrl}/api/openchamber/events`, { headers: { cookie: host.cookie }, signal: eventsAbort.signal });
  assert.equal(response.status, 200);
  const received = (async () => {
    let text = '';
    for await (const chunk of response.body) {
      text += new TextDecoder().decode(chunk);
      if (text.includes('openchamber:bots-changed')) return true;
    }
    return false;
  })();
  const settings = await host.request('/api/config/settings');
  assert.equal(settings.status, 200);
  const projectId = settings.body.projects.find((project) => project.path === repository).id;
  const base = `/api/projects/${encodeURIComponent(projectId)}/bots`;
  assert.equal((await fetch(host.baseUrl + base)).status, 401);
  let configured;
  const deadline = Date.now() + 10_000;
  do {
    configured = await host.request(`${base}/config`, 'PUT', { config: { definitions: [{ id: 'bugs', name: 'Bug bot', mission: 'Fix verified bugs' }] } });
    if (configured.status !== 503 || configured.body.code !== 'BOT_HOST_NOT_READY') break;
    await delay(25);
  } while (Date.now() < deadline);
  assert.equal(configured.status, 200, `${JSON.stringify(configured.body)}\n${host.logs()}`);
  const item = await host.request(`${base}/items`, 'POST', { botId: 'bugs', title: 'Fixture issue', source: { kind: 'manual', id: 'fixture' } });
  assert.equal(item.status, 200); assert.equal(item.body.item.state, 'needs-you');
  assert.equal(item.body.item.wait.reason, 'BOT_IDENTITY_REQUIRED');
  const timeout = setTimeout(() => eventsAbort.abort(), 5_000);
  assert.equal(await received, true); clearTimeout(timeout); eventsAbort.abort();
  const center = await host.request('/api/notification-center?version=2');
  assert.equal(center.status, 200);
  assert(JSON.stringify(center.body).includes(item.body.item.id), 'Durable item attention did not reach the real notification route');
  const hostInbox = await host.request('/api/openchamber/bots/isolated-tools?sessionId=ses_child');
  assert.notEqual(hostInbox.status, 200, 'The host exposed a child inbox');
  await host.close();
  const child = await launch(true);
  assert.equal((await child.request('/api/openchamber/bots/isolated-tools?sessionId=ses_child')).status, 200);
  assert.equal((await child.request(base)).status, 501);
  await assert.rejects(fs.stat(path.join(child.dataDir, 'bot-identities.json')), { code: 'ENOENT' });
  await child.close();
  console.log('Bots production index driver passed: authenticated config, admission, missing identity attention, notification route, SSE, child-only inbox, no child identities, clean shutdown.');
  console.log('Controlled OpenCode HTTP peer. No live provider writes, model inference, push delivery, Docker, relay device or packaged desktop claim.');
} finally {
  for (const child of children) child.kill('SIGKILL');
  for (const stream of streams) stream.destroy();
  upstream.closeAllConnections(); await new Promise((resolve) => upstream.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
