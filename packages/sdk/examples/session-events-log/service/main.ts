// A service that keeps a journal of what happens in the user's sessions.
// OpenChamber posts every event the manifest subscribed to, from every
// project, whether or not a window is open; this service writes each one as
// a JSON line. Runs under the app's Node runtime on 127.0.0.1, reachable only
// through the host.
import { appendFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { SESSION_EVENTS_PATH, readSessionEventRequest, type GuestSessionEventResult } from '@openchamber/sdk';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

// Where the journal goes. `SESSION_JOURNAL_FILE` is for tests; a user gets the file in their home.
const journalFile = process.env.SESSION_JOURNAL_FILE || path.join(os.homedir(), '.openchamber-session-events.log');

// Which projects to journal. OpenChamber sends every project's events; which
// ones an extension acts on is the extension's own choice. An empty list means
// every project. A real extension would keep this in its own settings.
const projects = (process.env.SESSION_JOURNAL_PROJECTS ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
const journals = (directory: string | null): boolean => projects.length === 0 || (directory !== null && projects.includes(directory));

/** What this service answers: a session event result, or an error on a route that is not one. */
type Answer = GuestSessionEventResult | { error: string };

const json = (res: http.ServerResponse, status: number, body: Answer): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const readBody = (req: http.IncomingMessage): Promise<string> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => resolve(body));
  req.on('error', reject);
});

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/health') {
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === SESSION_EVENTS_PATH && req.method === 'POST') {
    void readBody(req).then(async (body) => {
      const request = readSessionEventRequest(body);
      if (!request) {
        json(res, 400, { ok: false, error: 'not a session event this service understands' });
        return;
      }
      const { event, content } = request;
      if (!journals(event.project.directory)) {
        // Not one of ours: taken and dropped, which is a delivery as far as OpenChamber is concerned.
        json(res, 200, { ok: true });
        return;
      }
      try {
        await appendFile(journalFile, `${JSON.stringify(content ? { ...event, content } : event)}\n`);
        json(res, 200, { ok: true });
      } catch (error) {
        // Say what failed on this side; OpenChamber logs this text and nothing of the event.
        json(res, 200, { ok: false, error: `could not write the journal: ${error instanceof Error ? error.message : String(error)}` });
      }
    }).catch(() => json(res, 500, { ok: false, error: 'could not read the request' }));
    return;
  }
  json(res, 404, { error: 'not-found' });
});

server.listen(port, '127.0.0.1');
