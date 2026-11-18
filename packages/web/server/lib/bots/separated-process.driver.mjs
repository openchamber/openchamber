import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { isNumber } from '../shared/guards.js';

// Disposable real index.js processes. The OpenCode peer is controlled and the
// fixture has no provider credentials, Docker or Git repository.
const root = await fs.mkdtemp('/tmp/opencode/bots-separated-process-');
const project = path.join(root, 'registered-project');
const children = new Set(); const streams = new Set();
await fs.mkdir(path.join(project, '.agents/areas'), { recursive: true });
await fs.writeFile(path.join(project, '.agents/areas/core.md'), '---\nname: Core\npaths: [src/**]\nlevel: human\nowners: []\n---\nReview\n');
const peer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://controlled.invalid');
  if (url.pathname.endsWith('/event')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': connected\n\n');
    streams.add(res); res.once('close', () => streams.delete(res)); return;
  }
  res.setHeader('content-type', 'application/json');
  if (url.pathname === '/api/info') return res.end(JSON.stringify({ version: '2.2.5' }));
  if (url.pathname === '/api/session/active') return res.end(JSON.stringify({ data: {} }));
  if (url.pathname === '/api/session') return res.end(JSON.stringify({ data: [], cursor: {} }));
  res.end(JSON.stringify({ data: [] }));
});
await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));
const peerOrigin = `http://127.0.0.1:${peer.address().port}`;

const launch = async (role, projects, agent = null) => {
  const home = path.join(root, role); const dataDir = path.join(home, '.config/openchamber');
  await fs.mkdir(dataDir, { recursive: true });
  try { await fs.access(path.join(dataDir, 'settings.json')); }
  catch { await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({ projects,
    nativeNotificationsEnabled: false, notifyOnCompletion: false, isolatedSpacesEnabled: false })); }
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local/share'), CI: 'true', GIT_MASTER: '1',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    OPENCHAMBER_DATA_DIR: dataDir, OPENCHAMBER_RELAY_HOST: 'off',
    OPENCODE_HOST: peerOrigin, OPENCODE_PORT: String(peer.address().port), OPENCODE_SKIP_START: 'true',
    ...(role === 'agent' ? { OPENCHAMBER_AGENT_SERVER: '1' } : {
      OPENCHAMBER_AGENT_SERVER_URL: agent.origin, OPENCHAMBER_AGENT_SERVER_TOKEN: 'disposable-driver-password' }),
  };
  const code = `import {startWebUiServer} from ${JSON.stringify(new URL('../../index.js', import.meta.url).href)};
    const server=await startWebUiServer({port:0,host:'127.0.0.1',apiOnly:true,uiPassword:'disposable-driver-password',attachSignals:false,ownsProject:async()=>true});
    process.send({type:'ready',port:server.getPort()});
    process.on('message',async message=>{if(message==='stop'){await server.stop();process.exit(0);}});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env, windowsHide: true,
    cwd: path.resolve(new URL('../../../..', import.meta.url).pathname), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.add(child); let output = '';
  for (const channel of [child.stdout, child.stderr]) channel.on('data', (chunk) => { output = (output + chunk).slice(-30_000); });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${role} startup timed out\n${output}`)), 60_000);
    child.on('message', (message) => { if (message.type === 'ready') { clearTimeout(timer); resolve(message); } });
    child.once('exit', (status) => { clearTimeout(timer); reject(new Error(`${role} exited ${status}\n${output}`)); });
  });
  const origin = `http://127.0.0.1:${ready.port}`;
  const login = await fetch(`${origin}/auth/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'disposable-driver-password' }) });
  assert.equal(login.status, 200); const cookie = login.headers.get('set-cookie').split(';')[0];
  const request = async (route, method = 'GET', body) => {
    const options = { method, headers: { cookie }, signal: AbortSignal.timeout(30_000) };
    if (body) {
      options.headers['content-type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    const response = await fetch(origin + route, options);
    return { status: response.status, body: await response.json() };
  };
  return { origin, dataDir, request, logs: () => output, async close() {
    const exited = once(child, 'exit'); child.send('stop'); const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const [status] = await exited; clearTimeout(timer); children.delete(child); assert.equal(status, 0, output);
  } };
};

try {
  let agent = await launch('agent', [{ id: 'fixture', path: project, name: 'Controlled project' }]);
  const settings = await agent.request('/api/config/settings');
  assert.equal(settings.status, 200);
  const projects = settings.body.projects; const projectId = projects.find((entry) => entry.path === project).id;
  const owner = await launch('owner', projects, agent);
  const base = `/api/projects/${encodeURIComponent(projectId)}/bots`;
  assert.equal((await fetch(owner.origin + base)).status, 401);
  const config = { definitions: [{ id: 'fixture', name: 'Fixture Bot', mission: 'Controlled boundary test', isolated: true }] };
  let saved; const deadline = Date.now() + 10_000;
  do {
    saved = await owner.request(`${base}/config`, 'PUT', { config });
    if (saved.status !== 503 || saved.body.code !== 'BOT_HOST_NOT_READY') break;
    await delay(25);
  } while (Date.now() < deadline);
  assert.equal(saved.status, 200, `${JSON.stringify(saved)}\n${owner.logs()}`);
  assert.equal((await agent.request(base)).status, 403, 'Agent must have no public coordinator');
  for (const route of ['/api/openchamber/bot-services/identity-list', '/API/OPENCHAMBER/%62ot-services/checkout-create']) {
    assert.equal((await owner.request(route, 'POST', {})).status, 403, 'Owner clients must not reach private execution');
  }
  const policy = await owner.request(`${base}/policy`);
  assert.equal(policy.status, 200); assert.equal(policy.body.areas[0].status, 'unapproved');
  assert.equal((await owner.request(`${base}/policy/approve`, 'POST', { file: policy.body.areas[0].file,
    fingerprint: policy.body.areas[0].fingerprint })).status, 200);
  assert.equal((await owner.request(`${base}/policy`)).body.areas[0].status, 'approved');
  const admitted = await owner.request(`${base}/items`, 'POST', { botId: 'fixture', source: { kind: 'manual', id: 'controlled' }, title: 'Controlled refusal' });
  assert.equal(admitted.status, 200, JSON.stringify(admitted));
  assert.equal(admitted.body.item.state, 'needs-you');
  const itemId = admitted.body.item.id;
  assert.deepEqual(admitted.body.item.sessions, {});
  const pending = (await owner.request('/api/notification-center?version=2')).body.entries.find((entry) => entry.kind === 'bot' && entry.requestId === itemId);
  assert(pending, 'Owner must persist attention before a stage session exists');
  assert.equal(pending.sessionId, null); assert.equal(pending.resolvedAt, null);
  assert.deepEqual(pending.action, { type: 'bots', projectId, itemId });
  assert.equal((await owner.request('/api/notification-center/read', 'POST', { ids: [pending.id] })).status, 200);
  assert.equal((await owner.request(`${base}/items/${itemId}`)).body.item.id, itemId);
  await assert.rejects(fs.stat(path.join(owner.dataDir, 'bot-identities.json')), { code: 'ENOENT' });
  await agent.close();
  assert.equal((await owner.request(`${base}/items/${itemId}`)).body.item.id, itemId, 'Offline execution cannot erase owner control state');
  const offlinePolicy = await owner.request(`${base}/policy`);
  assert(offlinePolicy.status >= 400, 'A failed execution read must not become an empty approved policy');
  await owner.close();
  // A fresh owner uses its durable control state, without bootstrapping it from the agent.
  agent = await launch('agent', projects);
  const restarted = await launch('owner', projects, agent);
  assert.equal((await restarted.request(`${base}/items/${itemId}`)).body.item.id, itemId);
  assert.equal((await restarted.request(`${base}/policy`)).body.areas[0].status, 'approved');
  const restoredAttention = (await restarted.request('/api/notification-center?version=2')).body.entries.find((entry) => entry.id === pending.id);
  assert(restoredAttention); assert.equal(restoredAttention.resolvedAt, null); assert(isNumber(restoredAttention.readAt));
  assert.equal((await restarted.request(`${base}/items/${itemId}/stop`, 'POST', {})).body.item.state, 'stopped');
  const resolvedAttention = (await restarted.request('/api/notification-center?version=2')).body.entries.find((entry) => entry.id === pending.id);
  assert(resolvedAttention); assert(isNumber(resolvedAttention.resolvedAt));
  await restarted.close(); await agent.close();
  console.log('Separated Bots process driver passed: real role composition, owner control and approvals, typed policy read, public/private refusals, owner-created sessionless attention pending -> restart -> resolved, offline retention and shutdown.');
  console.log('Controlled OpenCode peer only. No provider write, Git checkout, stage inference, Spaces/grant execution, separate Unix-account enforcement, relay device or packaged Electron claim.');
} finally {
  for (const child of children) child.kill('SIGKILL');
  for (const response of streams) response.destroy();
  peer.closeAllConnections(); await new Promise((resolve) => peer.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
