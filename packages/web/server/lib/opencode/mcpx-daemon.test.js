import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { callDaemon, MCPX_DAEMON_DISCOVERY_MAX_BYTES, MCPX_DAEMON_MAX_RESPONSE_BYTES, MCPX_DAEMON_TIMEOUT_MS } from './mcpx-daemon.js';

const OPTS = { timeoutMs: 150, maxResponseBytes: 1024 };
const ENV_KEYS = ['MCPX_DAEMON_ENDPOINT', 'MCPX_ENDPOINT', 'MCPX_SOCKET', 'MCPX_STATE_DIR'];
const savedEnv = {};
let servers = [];
let tmpDirs = [];

const handler = (req, res) => {
  if (req.url === '/stall') return; // never answer
  if (req.url === '/trickle') {
    // A chunk every 30 ms, never completing: inside the idle window,
    // so only an absolute deadline can stop this response.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const timer = setInterval(() => res.write(' '), 30);
    res.on('close', () => clearInterval(timer));
    return;
  }
  if (req.url === '/big') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('x'.repeat(4096));
    return res.end('x'.repeat(4096));
  }
  if (req.url === '/big-error') {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.write('e'.repeat(4096));
    return res.end('e'.repeat(4096));
  }
  if (req.url === '/error') {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    return res.end('daemon broke');
  }
  if (req.url === '/text') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('plain answer');
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  return res.end(JSON.stringify({ ok: true }));
};

const startHttpDaemon = async () => {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
};

const startSocketDaemon = async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpx-daemon-test-'));
  tmpDirs.push(dir);
  const socketPath = path.join(dir, 'daemon.sock');
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(socketPath, resolve));
  return socketPath;
};

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await Promise.all(servers.map((s) => new Promise((resolve) => {
    s.closeAllConnections?.();
    s.close(() => resolve());
  })));
  servers = [];
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

describe('mcpx daemon client', () => {
  it('exports named timeout and cap constants', () => {
    expect(MCPX_DAEMON_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MCPX_DAEMON_MAX_RESPONSE_BYTES).toBeGreaterThan(0);
  });

  it('HTTP: parses healthy JSON', async () => {
    process.env.MCPX_DAEMON_ENDPOINT = await startHttpDaemon();
    delete process.env.MCPX_SOCKET;
    await expect(callDaemon('/ok', 'GET', null, {}, OPTS)).resolves.toEqual({ ok: true });
  });

  it('HTTP: >=400 throws with status and bounded body', async () => {
    process.env.MCPX_DAEMON_ENDPOINT = await startHttpDaemon();
    await expect(callDaemon('/error', 'GET', null, {}, OPTS)).rejects.toThrow('mcpx daemon HTTP 500: daemon broke');
  });

  it('HTTP: stalled daemon rejects with a timeout', async () => {
    process.env.MCPX_DAEMON_ENDPOINT = await startHttpDaemon();
    await expect(callDaemon('/stall', 'GET', null, {}, OPTS)).rejects.toThrow('mcpx daemon timed out');
  });

  it('HTTP: over-cap body rejects during the read', async () => {
    process.env.MCPX_DAEMON_ENDPOINT = await startHttpDaemon();
    await expect(callDaemon('/big', 'GET', null, {}, OPTS)).rejects.toThrow('exceeded 1024 bytes');
  });

  it('HTTP: over-cap error body rejects instead of buffering it whole', async () => {
    process.env.MCPX_DAEMON_ENDPOINT = await startHttpDaemon();
    await expect(callDaemon('/big-error', 'GET', null, {}, OPTS)).rejects.toThrow('exceeded 1024 bytes');
  });

  it('socket: parses healthy JSON and resolves non-JSON as text', async () => {
    delete process.env.MCPX_DAEMON_ENDPOINT;
    delete process.env.MCPX_ENDPOINT;
    process.env.MCPX_SOCKET = await startSocketDaemon();
    await expect(callDaemon('/ok', 'GET', null, {}, OPTS)).resolves.toEqual({ ok: true });
    await expect(callDaemon('/text', 'GET', null, {}, OPTS)).resolves.toBe('plain answer');
  });

  it('socket: >=400 rejects with status and body', async () => {
    delete process.env.MCPX_DAEMON_ENDPOINT;
    delete process.env.MCPX_ENDPOINT;
    process.env.MCPX_SOCKET = await startSocketDaemon();
    await expect(callDaemon('/error', 'GET', null, {}, OPTS)).rejects.toThrow('mcpx daemon HTTP 500: daemon broke');
  });

  it('socket: stalled daemon rejects with a timeout', async () => {
    delete process.env.MCPX_DAEMON_ENDPOINT;
    delete process.env.MCPX_ENDPOINT;
    process.env.MCPX_SOCKET = await startSocketDaemon();
    await expect(callDaemon('/stall', 'GET', null, {}, OPTS)).rejects.toThrow('mcpx daemon timed out');
  });

  it('socket: trickling response rejects at the absolute deadline, not the idle timeout', async () => {
    delete process.env.MCPX_DAEMON_ENDPOINT;
    delete process.env.MCPX_ENDPOINT;
    process.env.MCPX_SOCKET = await startSocketDaemon();
    const started = Date.now();
    await expect(callDaemon('/trickle', 'GET', null, {}, OPTS)).rejects.toThrow('mcpx daemon timed out');
    // OPTS.timeoutMs is 150; chunks arrive every 30 ms, so the idle
    // timer never fires — rejection well under 1s proves the deadline.
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('discovery: a FIFO daemon-*.json is skipped and a valid record still discovers its socket', async () => {
    delete process.env.MCPX_DAEMON_ENDPOINT;
    delete process.env.MCPX_ENDPOINT;
    delete process.env.MCPX_SOCKET;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpx-discovery-fifo-'));
    tmpDirs.push(dir);
    process.env.MCPX_STATE_DIR = dir;
    execFileSync('mkfifo', [path.join(dir, 'daemon-a.json')]);
    const socketPath = await startSocketDaemon();
    fs.writeFileSync(path.join(dir, 'daemon-b.json'), JSON.stringify({ socket: socketPath }));
    const started = Date.now();
    await expect(callDaemon('/ok', 'GET', null, {}, OPTS)).resolves.toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('discovery: a FIFO alone answers No mcpx daemon reachable instead of blocking', async () => {
    delete process.env.MCPX_DAEMON_ENDPOINT;
    delete process.env.MCPX_ENDPOINT;
    delete process.env.MCPX_SOCKET;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpx-discovery-fifo-only-'));
    tmpDirs.push(dir);
    process.env.MCPX_STATE_DIR = dir;
    execFileSync('mkfifo', [path.join(dir, 'daemon-a.json')]);
    await expect(callDaemon('/ok', 'GET', null, {}, OPTS)).rejects.toThrow('No mcpx daemon reachable');
  });

  it('discovery: an over-cap daemon-*.json is skipped without being parsed whole', async () => {
    delete process.env.MCPX_DAEMON_ENDPOINT;
    delete process.env.MCPX_ENDPOINT;
    delete process.env.MCPX_SOCKET;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcpx-discovery-big-'));
    tmpDirs.push(dir);
    process.env.MCPX_STATE_DIR = dir;
    const socketPath = await startSocketDaemon();
    const big = JSON.stringify({ socket: socketPath, pad: 'x'.repeat(MCPX_DAEMON_DISCOVERY_MAX_BYTES) });
    expect(big.length).toBeGreaterThan(MCPX_DAEMON_DISCOVERY_MAX_BYTES);
    fs.writeFileSync(path.join(dir, 'daemon-a.json'), big);
    await expect(callDaemon('/ok', 'GET', null, {}, OPTS)).rejects.toThrow('No mcpx daemon reachable');
    fs.writeFileSync(path.join(dir, 'daemon-b.json'), JSON.stringify({ socket: socketPath }));
    await expect(callDaemon('/ok', 'GET', null, {}, OPTS)).resolves.toEqual({ ok: true });
  });

  it('socket: over-cap body rejects during the read', async () => {
    delete process.env.MCPX_DAEMON_ENDPOINT;
    delete process.env.MCPX_ENDPOINT;
    process.env.MCPX_SOCKET = await startSocketDaemon();
    await expect(callDaemon('/big', 'GET', null, {}, OPTS)).rejects.toThrow('exceeded 1024 bytes');
  });
});
