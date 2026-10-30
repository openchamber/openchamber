import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sessionEventResultSchema } from '../src/service-provider-schemas';
import { SESSION_EVENTS_PATH, type GuestSessionEventRequest } from '../src/session-events';

// Runs the checked-in service bundle the way OpenChamber does: a loopback
// port and bearer, then one POST per event, and reads the journal it keeps.

const serviceEntry = fileURLToPath(new URL('../examples/session-events-log/service/main.js', import.meta.url));

const freePort = () => new Promise<number>((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = Object(server.address());
    server.close(() => resolve(Number(port)));
  });
});

let service: ChildProcess;
let servicePort: number;
let journalDir: string;
let journalFile: string;
const serviceToken = randomBytes(16).toString('hex');

beforeAll(async () => {
  journalDir = await mkdtemp(path.join(tmpdir(), 'oc-session-journal-'));
  journalFile = path.join(journalDir, 'journal.log');
  servicePort = await freePort();
  service = spawn('node', [serviceEntry], {
    env: {
      PATH: process.env.PATH,
      OPENCHAMBER_SERVICE_PORT: String(servicePort),
      OPENCHAMBER_SERVICE_TOKEN: serviceToken,
      SESSION_JOURNAL_FILE: journalFile,
      SESSION_JOURNAL_PROJECTS: '/repo/journaled',
    },
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const ready = await fetch(`http://127.0.0.1:${servicePort}/health`, { headers: { authorization: `Bearer ${serviceToken}` } })
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return;
    await new Promise((resolve) => { setTimeout(resolve, 50); });
  }
  throw new Error('the session journal service did not become ready');
});

afterAll(async () => {
  service?.kill();
  await rm(journalDir, { recursive: true, force: true });
});

const post = (body: GuestSessionEventRequest | { hello: string }, token = serviceToken) => fetch(`http://127.0.0.1:${servicePort}${SESSION_EVENTS_PATH}`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const request = (event: GuestSessionEventRequest['event'], content?: GuestSessionEventRequest['content']): GuestSessionEventRequest => {
  const delivery: GuestSessionEventRequest = { v: 1, requestId: `req-${event.id}`, event };
  if (content) delivery.content = content;
  return delivery;
};

const base = (id: string, type: GuestSessionEventRequest['event']['type'], directory = '/repo/journaled') => ({
  id, type, at: 1_700_000_000_000,
  session: { id: 'ses_1', parentId: null },
  project: { directory },
  linked: [{ id: 'linear:OPE-367', kind: 'linear', url: 'https://linear.app/x/OPE-367', provider: 'linear', identifier: 'OPE-367' }],
});

describe('session journal example', () => {
  test('journals each event type it is told about, with its content, and answers ok', async () => {
    const deliveries = [
      request(base('evt_1', 'turn-finished'), { type: 'turn-finished', sessionTitle: 'Fix the parser', reply: 'Done.', replyTruncated: false }),
      request(base('evt_2', 'turn-failed'), { type: 'turn-failed', sessionTitle: 'Fix the parser', error: { type: 'APIError', message: 'rate limited' } }),
      request({ ...base('evt_3', 'permission-asked'), permission: { requestId: 'perm_1' } }, {
        type: 'permission-asked', sessionTitle: 'Fix the parser', action: 'bash', resources: ['rm -rf dist'], message: 'Clean the build',
      }),
      request(base('evt_4', 'question-asked'), {
        type: 'question-asked', sessionTitle: 'Fix the parser', ask: { kind: 'form', id: 'form_1', title: 'Which?', fields: [{ title: 'Branch', description: null }] },
      }),
      // Identifiers only: a subscriber without the content grant.
      request(base('evt_5', 'turn-finished')),
    ];
    for (const delivery of deliveries) {
      const response = await post(delivery);
      expect(response.status).toBe(200);
      expect(sessionEventResultSchema.parse(await response.json())).toEqual({ ok: true });
    }
    const lines = (await readFile(journalFile, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => [line.id, line.type])).toEqual([
      ['evt_1', 'turn-finished'], ['evt_2', 'turn-failed'], ['evt_3', 'permission-asked'], ['evt_4', 'question-asked'], ['evt_5', 'turn-finished'],
    ]);
    expect(lines[0].content).toEqual({ type: 'turn-finished', sessionTitle: 'Fix the parser', reply: 'Done.', replyTruncated: false });
    expect(lines[0].linked).toEqual(deliveries[0].event.linked);
    expect(lines[2].permission).toEqual({ requestId: 'perm_1' });
    expect(lines[4]).not.toHaveProperty('content');
  });

  test('takes and drops an event of a project it does not journal', async () => {
    const before = (await readFile(journalFile, 'utf8')).length;
    const response = await post(request(base('evt_other', 'turn-finished', '/repo/other')));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect((await readFile(journalFile, 'utf8')).length).toBe(before);
  });

  test('refuses a body that is not a session event, and a caller without the bearer', async () => {
    expect((await post({ hello: 'world' })).status).toBe(400);
    expect((await post(request(base('evt_x', 'turn-finished')), 'wrong')).status).toBe(401);
    expect((await fetch(`http://127.0.0.1:${servicePort}/anything`, { headers: { authorization: `Bearer ${serviceToken}` } })).status).toBe(404);
  });
});
