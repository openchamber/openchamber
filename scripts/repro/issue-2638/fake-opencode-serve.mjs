#!/usr/bin/env node
// Fake `opencode serve` used to reproduce https://github.com/openchamber/openchamber/issues/2638
//
// Modes (controlled by env):
//   FAKE_OPENCODE_CORE=1      – server-core mode: binds the port, serves
//                               /global/health + SSE /global/event, ignores
//                               SIGTERM so it survives its launcher's death
//                               (Windows-style orphaned server process).
//   FAKE_OPENCODE_BASELINE=1  – in-process mode: the server runs inside the
//                               managed process and dies with it (normal
//                               Linux behavior used as a control).
//   default (launcher)        – spawns a detached core grandchild, waits for
//                               it to bind, prints the `opencode server
//                               listening on ...` line the lifecycle greps
//                               for, stays alive, and on SIGTERM exits WITHOUT
//                               killing the core (mimics opencode.exe dying
//                               while its server child survives).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const hostnameIndex = args.indexOf('--hostname');
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;
const hostname = hostnameIndex >= 0 ? args[hostnameIndex + 1] : '127.0.0.1';
const pidDir = process.env.FAKE_OPENCODE_PID_DIR || null;

function writePidFile(label) {
  if (!pidDir) return;
  try {
    fs.mkdirSync(pidDir, { recursive: true });
    fs.writeFileSync(path.join(pidDir, `${label}-${port}.pid`), String(process.pid));
  } catch {
    // best effort
  }
}

function createServer() {
  const clients = new Set();
  const emitted = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${hostname}:${port}`);
    if (url.pathname === '/global/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ healthy: true }));
      return;
    }
    if (url.pathname === '/global/event') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      clients.add(res);
      req.on('close', () => clients.delete(res));
      // SSE keep-alive comments — exactly what a real OpenCode server sends,
      // which prevents the upstream reader's 20s stall timer from firing.
      const keepalive = setInterval(() => {
        res.write(': keepalive\n\n');
      }, 1000);
      req.on('close', () => clearInterval(keepalive));
      return;
    }
    if (url.pathname === '/emit') {
      const type = url.searchParams.get('type') || 'session.updated';
      const id = url.searchParams.get('id') || `evt-${Date.now()}`;
      emitted.push({ id, type });
      const block = `id: ${id}\ndata: ${JSON.stringify({ type, id })}\n\n`;
      for (const client of clients) client.write(block);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, id }));
      return;
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(emitted));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  return { server };
}

const runServer = (label) => {
  createServer().server.listen(port, hostname, () => {
    console.log(`opencode server listening on http://${hostname}:${port}`);
  });
  writePidFile(label);
  setInterval(() => {}, 1 << 30);
};

const main = async () => {
  // Server-core mode: the orphaned server. Survives its launcher's death.
  if (process.env.FAKE_OPENCODE_CORE === '1') {
    runServer('core');
    process.on('SIGTERM', () => {});
    process.on('SIGINT', () => {});
    return;
  }

  // Baseline in-process mode (control): dies with the managed process, so the
  // port is properly released on restart.
  if (process.env.FAKE_OPENCODE_BASELINE === '1') {
    runServer('baseline');
    return;
  }

  // Launcher mode: spawn a detached core grandchild, wait for it to bind,
  // print the listening line, and on SIGTERM exit leaving the core running.
  const core = spawn(process.execPath, [process.argv[1], ...args], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: { ...process.env, FAKE_OPENCODE_CORE: '1' },
  });
  core.unref();

  for (let i = 0; i < 200; i += 1) {
    if (core.exitCode !== null) throw new Error('core exited early');
    const ok = await new Promise((resolve) => {
      const socket = net.connect({ port, host: hostname });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 200);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (ok) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  writePidFile('launcher');
  console.log(`opencode server listening on http://${hostname}:${port}`);
  // On SIGTERM exit ourselves, leaving the detached core running.
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
  setInterval(() => {}, 1 << 30);
};

await main();
