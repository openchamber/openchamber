import { createServer } from 'node:http';
import { once } from 'node:events';

export const FIXTURE_TOKEN = 'mobile-smoke-token';
export const OPERATION_ID = 'mobile-smoke-operation';

export function createSecureWorkspaceFixture() {
  let starts = 0;
  let retryable = true;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${FIXTURE_TOKEN}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url !== '/api/workspaces/sessions/start' || request.method !== 'POST') {
      response.writeHead(404);
      response.end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      if (payload.operationID !== OPERATION_ID) {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'operation ID mismatch' }));
        return;
      }
      if (retryable) {
        retryable = false;
        response.writeHead(202, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'WORKSPACE_SESSION_START_RETRYABLE', retryable: true, operationID: OPERATION_ID }));
        return;
      }
      starts += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'completed', operationID: OPERATION_ID, workspaceID: 'mobile-smoke-workspace', session: { id: 'mobile-smoke-session', workspaceID: 'mobile-smoke-workspace', directory: '/smoke-project' } }));
    });
  });
  return {
    server,
    get starts() { return starts; },
    async start() { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address(); },
    async close() { if (server.listening) server.close(); await once(server, 'close').catch(() => {}); },
  };
}

export async function runFixtureSmoke() {
  const fixture = createSecureWorkspaceFixture();
  const address = await fixture.start();
  const url = `http://${address.address}:${address.port}`;
  const payload = { operationID: OPERATION_ID, directory: '/smoke-project', title: 'Mobile smoke' };
  const request = () => fetch(`${url}/api/workspaces/sessions/start`, { method: 'POST', headers: { authorization: `Bearer ${FIXTURE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  try {
    const health = await fetch(`${url}/health`, { headers: { authorization: `Bearer ${FIXTURE_TOKEN}` } });
    if (!health.ok) throw new Error('fixture authentication/health check failed');
    const first = await request();
    if (first.status !== 202) throw new Error(`expected retryable response, received ${first.status}`);
    const second = await request();
    const result = await second.json();
    if (second.status !== 200 || result.status !== 'completed' || result.session?.workspaceID !== 'mobile-smoke-workspace') throw new Error('fixture did not return a routed Secure Workspace session');
    if (fixture.starts !== 1) throw new Error(`expected one operation, received ${fixture.starts}`);
    return { status: 'passed', operationID: OPERATION_ID, sessionID: result.session.id, starts: fixture.starts };
  } finally { await fixture.close(); }
}

if (import.meta.main) runFixtureSmoke().then((result) => console.log(JSON.stringify(result))).catch((error) => { console.error(error.message); process.exitCode = 1; });
