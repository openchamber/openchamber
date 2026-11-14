// The service of Agent Desk. OpenChamber keeps it running and wakes it every
// minute; it reaches back through `createServiceHost` with no window involved.
import http from 'node:http';

import {
  MENTIONS_RESOLVE_PATH,
  MENTIONS_SEARCH_PATH,
  MENTION_TITLE_MAX,
  SERVICE_SCHEDULE_PATH,
  createServiceHost,
  readServiceScheduleRequest,
  type JsonValue,
  type MentionsResolveRequest,
  type MentionsSearchRequest,
} from '@openchamber/sdk';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const host = createServiceHost({ env: process.env });

const notes = new Map<string, string>([
  ['release', 'The next release ships on Thursday. Nothing merges after Wednesday noon.'],
  ['oncall', 'Whoever is on call owns the deploy channel this week.'],
]);

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const json = (res: http.ServerResponse, status: number, body: JsonValue): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const route = async (path: string, body: string, res: http.ServerResponse): Promise<void> => {
  if (path === SERVICE_SCHEDULE_PATH) {
    const run = readServiceScheduleRequest(body);
    if (!run) { json(res, 400, { error: 'not a scheduled run' }); return; }
    json(res, 200, { ok: true });
    await host.emit('tick', { at: run.at }).catch(() => undefined);
    return;
  }
  if (path === MENTIONS_SEARCH_PATH) {
    const { query }: MentionsSearchRequest = JSON.parse(body);
    const items = [...notes.keys()].filter((id) => id.includes(query.toLowerCase())).map((id) => ({ id, title: id, subtitle: (notes.get(id) ?? '').slice(0, MENTION_TITLE_MAX) }));
    json(res, 200, { items });
    return;
  }
  if (path === MENTIONS_RESOLVE_PATH) {
    const { id }: MentionsResolveRequest = JSON.parse(body);
    const text = notes.get(id);
    if (!text) { json(res, 404, { error: 'unknown note' }); return; }
    json(res, 200, { text });
    return;
  }
  if (path === '/start') {
    const { directory }: { directory?: string | null } = JSON.parse(body);
    const started = await host.sessions.start({ prompt: 'Say hello from Agent Desk in one line.', title: 'Agent Desk', ...(directory ? { directory } : {}) });
    json(res, 200, started);
    // The session's row in the sidebar carries the desk's mark until this process ends.
    await host.setMark({ sessionId: started.sessionId }, { icon: 'robot-2', tone: 'info', text: 'Started from the desk' }).catch(() => undefined);
    return;
  }
  if (path === '/note') {
    const { note }: { note: string } = JSON.parse(body);
    notes.set(`note-${notes.size + 1}`, note);
    json(res, 200, { saved: true });
    return;
  }
  json(res, 404, { error: 'not found' });
};

http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { json(res, 401, { error: 'unauthorized' }); return; }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') { json(res, 200, { ok: true }); return; }
  readBody(req).then((body) => route(url.pathname, body, res)).catch(() => {
    if (!res.headersSent) json(res, 500, { error: 'failed' });
  });
}).listen(port, '127.0.0.1', () => {
  void host.setInstructions(null, 'The team keeps its notes in Agent Desk. Mention them when a release comes up.').catch(() => undefined);
});
