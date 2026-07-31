#!/usr/bin/env node

import http from 'node:http';

const readFlag = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const hostname = readFlag('--hostname') || '127.0.0.1';
const port = Number.parseInt(readFlag('--port') || '', 10);

if (!Number.isSafeInteger(port) || port <= 0 || port > 65535) {
  process.stderr.write('guardian test OpenCode requires a valid --port\n');
  process.exit(2);
}

const server = http.createServer((request, response) => {
  if (request.url === '/global/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ healthy: true }));
    return;
  }
  response.writeHead(404);
  response.end();
});

const close = () => {
  server.close(() => process.exit(0));
};

process.once('SIGTERM', close);
process.once('SIGINT', close);

server.on('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

server.listen(port, hostname, () => {
  process.stdout.write(`opencode server listening on http://${hostname}:${port}\n`);
});
