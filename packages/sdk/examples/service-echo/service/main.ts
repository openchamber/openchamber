// Runs under the app's Node runtime, on 127.0.0.1, only reachable through the host proxy.
import { execFile } from 'node:child_process';
import http from 'node:http';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!port || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

let calls = 0;
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
  if (url.pathname === '/echo') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      calls += 1;
      json(res, 200, { calls, method: req.method, query: Object.fromEntries(url.searchParams), body, pid: process.pid });
    });
    return;
  }
  if (url.pathname === '/uname') {
    execFile('uname', ['-a'], (error, stdout) => {
      json(res, error ? 500 : 200, error ? { error: error.message } : { uname: stdout.trim() });
    });
    return;
  }
  json(res, 404, { error: 'not-found' });
});

server.listen(port, '127.0.0.1');
