// The dispatcher in front of a real space on a real Docker daemon. Runs only with
// OPENCHAMBER_TEST_DOCKER=1. Two parts: the dispatcher over the Docker place, mounted in an
// Express app the way `server/index.js` mounts it; and the real server started headless, once
// with the switch off and once with it on, in front of a stand-in Docker daemon that records
// whether anything ever spoke to it.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createSpacesHost } from '../host.js';
import { createSpaceId, hashProjectDirectory } from '../labels.js';
import { LIVE_DOCKER_ENABLED, createLiveDockerPlace } from './docker-live-support.js';

const CREATE_TIMEOUT_MS = 25 * 60_000;
const SERVER_ENTRY = fileURLToPath(new URL('../../../index.js', import.meta.url));

const temporary = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

const listen = (app) => new Promise((resolve) => {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => resolve(server));
});

describe.skipIf(!LIVE_DOCKER_ENABLED)('dispatcher over a real space: docker (live)', () => {
  const spec = {
    id: createSpaceId(),
    name: 'Dispatcher live',
    project: hashProjectDirectory('/dispatcher/live/project'),
    created: new Date().toISOString(),
    memoryBytes: 2 * 1024 * 1024 * 1024,
  };
  const repo = `/spaces/${spec.id}/repo`;
  let place;
  let dispose = async () => {};
  let dataDir;
  let host;
  let server;
  let hostRouteRuns = 0;
  const url = (suffix) => `http://127.0.0.1:${server.address().port}${suffix}`;
  const shell = async (script) => {
    const result = await place.exec(spec.id, ['sh', '-c', script]);
    expect(result.code, `${script}: ${result.stderr}`).toBe(0);
    return result.stdout;
  };

  beforeAll(async () => {
    ({ place, dispose } = createLiveDockerPlace());
    await place.create(spec);
    await shell(`mkdir -p ${repo} && cd ${repo} && git init -q . && git -c user.email=space@example.invalid -c user.name=Space commit -q --allow-empty -m init`);
    dataDir = temporary('openchamber-dispatcher-live-');
    host = createSpacesHost({ dataDir, place, logger: { warn: () => {} } });
    const app = express();
    // The host's auth gate stands in front of the dispatcher in the real server; here the request
    // is taken as authenticated, and one host route records whether it ever ran.
    app.use(host.middleware);
    app.all('/api/git/status', (req, res) => {
      hostRouteRuns += 1;
      res.json({ ranOnHost: true, directory: req.query.directory ?? null });
    });
    app.use((_req, res) => res.status(404).json({ error: 'not found on host' }));
    server = await listen(app);
  }, CREATE_TIMEOUT_MS);

  afterAll(async () => {
    host?.close();
    await new Promise((resolve) => { if (server) server.close(() => resolve()); else resolve(); });
    await dispose();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('forwards a prefixed request to the server inside and returns its answer', async () => {
    const response = await fetch(url(`/api/spaces/${spec.id}/session?directory=${encodeURIComponent(repo)}`));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('set-cookie')).toBeNull();
    const list = await response.json();
    expect(Array.isArray(list.data ?? list)).toBe(true);
  });

  it('creates a session inside through a streamed POST body, and lists it back', async () => {
    const created = await fetch(url(`/api/spaces/${spec.id}/session`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ location: { directory: repo } }),
    });
    expect(created.status, await created.clone().text()).toBe(200);
    const session = (await created.json()).data;
    expect(session.location.directory).toBe(repo);

    const listed = await fetch(url(`/api/spaces/${spec.id}/session?directory=${encodeURIComponent(repo)}`));
    const ids = ((await listed.json()).data ?? []).map((entry) => entry.id);
    expect(ids).toContain(session.id);
  });

  it('streams the event stream of the server inside', async () => {
    const controller = new AbortController();
    const response = await fetch(url(`/api/spaces/${spec.id}/event`), { signal: controller.signal, headers: { accept: 'text/event-stream' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(new TextDecoder().decode(value).length).toBeGreaterThan(0);
    controller.abort();
  }, 60_000);

  it('refuses a prefixed request that names a directory outside the space, and a host-only route', async () => {
    const outside = await fetch(url(`/api/spaces/${spec.id}/session?directory=${encodeURIComponent('/home/me/project')}`));
    expect(outside.status).toBe(400);
    expect(await outside.json()).toMatchObject({ code: 'directory_outside_space' });
    const hostOnly = await fetch(url(`/api/spaces/${spec.id}/config/settings`));
    expect(hostOnly.status).toBe(403);
    expect(await hostOnly.json()).toMatchObject({ code: 'host_only_route' });
  });

  // The escape check of TESTING.md: a request without the space prefix, but with a space
  // directory, does not run on the host.
  it('refuses an unprefixed request with the space\'s directory before any host route runs', async () => {
    const response = await fetch(url(`/api/git/status?directory=${encodeURIComponent(repo)}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'space_directory_needs_prefix' });
    expect(hostRouteRuns).toBe(0);
    const ordinary = await fetch(url('/api/git/status?directory=/tmp'));
    expect(ordinary.status).toBe(200);
    expect(hostRouteRuns).toBe(1);
  });

  // Processes inside are read from /proc, because the image has no pgrep. The match is anchored
  // to the bridge's own command line, so the shell that runs this count is not counted.
  const bridgesInside = async () => Number((await shell('n=0; for p in /proc/[0-9]*; do if tr "\\0" " " < "$p/cmdline" 2>/dev/null | grep -q "^/usr/local/bin/node -e "; then n=$((n+1)); fi; done; echo $n')).trim());

  it('ends the bridge inside when the host closes its connections', async () => {
    expect((await fetch(url(`/api/spaces/${spec.id}/session?directory=${encodeURIComponent(repo)}`))).status).toBe(200);
    expect(await bridgesInside()).toBeGreaterThan(0);
    host.close();
    let left = await bridgesInside();
    for (let attempt = 0; attempt < 40 && left > 0; attempt += 1) {
      await new Promise((resolve) => { setTimeout(resolve, 250); });
      left = await bridgesInside();
    }
    expect(left).toBe(0);
    // The next request opens a new one.
    expect((await fetch(url(`/api/spaces/${spec.id}/session?directory=${encodeURIComponent(repo)}`))).status).toBe(200);
  }, 60_000);

  it('answers 503 with a stable code for a stopped space, and serves it again after a start', async () => {
    await place.stop(spec.id);
    const stopped = await fetch(url(`/api/spaces/${spec.id}/session?directory=${encodeURIComponent(repo)}`));
    expect(stopped.status).toBe(503);
    expect(await stopped.json()).toMatchObject({ code: 'space_not_running' });

    await place.start(spec.id);
    const again = await fetch(url(`/api/spaces/${spec.id}/session?directory=${encodeURIComponent(repo)}`));
    expect(again.status).toBe(200);
  }, 5 * 60_000);
});

/**
 * The real server, started headless, with a stand-in for the Docker daemon on `DOCKER_HOST`
 * that records every connection. The docker CLI on this machine is the real one: whether the
 * feature ever called it is exactly what the daemon's connection count says.
 */
const startFakeDaemon = async (folder) => {
  const socketPath = path.join(folder, 'docker.sock');
  let connections = 0;
  const open = new Set();
  const daemon = net.createServer((socket) => {
    connections += 1;
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => {});
    socket.end('HTTP/1.1 500 Internal Server Error\r\ncontent-length: 0\r\n\r\n');
  });
  await new Promise((resolve) => daemon.listen(socketPath, resolve));
  return {
    host: `unix://${socketPath}`,
    connections: () => connections,
    // A docker CLI may hold a connection open; `close` alone would wait for it for ever.
    stop: () => new Promise((resolve) => {
      for (const socket of open) socket.destroy();
      daemon.close(() => resolve());
    }),
  };
};

const freePort = () => new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

const startServer = async ({ dataDir, dockerHost, port }) => {
  const child = spawn(process.execPath, [SERVER_ENTRY, '--port', String(port), '--api-only'], {
    env: { ...process.env, OPENCHAMBER_DATA_DIR: dataDir, DOCKER_HOST: dockerHost, OPENCHAMBER_RELAY_HOST: 'off' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  let healthy = false;
  while (!healthy && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the server left early:\n${output.slice(-2000)}`);
    try {
      healthy = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) })).status === 200;
    } catch {
      // Not up yet.
    }
    if (!healthy) await new Promise((resolve) => { setTimeout(resolve, 250); });
  }
  if (!healthy) throw new Error(`the server did not become healthy:\n${output.slice(-2000)}`);
  return {
    base,
    /** One request with a bound, so a hang names itself and the server's output instead of a timeout. */
    get: async (suffix) => {
      try {
        return await fetch(`${base}${suffix}`, { signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        throw new Error(`${suffix}: ${error.message}\n${output.slice(-2000)}`);
      }
    },
    output: () => output,
    stop: () => new Promise((resolve) => {
      child.once('exit', resolve);
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }),
  };
};

describe.skipIf(!LIVE_DOCKER_ENABLED)('the switch, on the real server (live)', () => {
  const folders = [];
  afterAll(() => {
    for (const folder of folders) fs.rmSync(folder, { recursive: true, force: true });
  });

  const startWith = async (enabled) => {
    const folder = temporary('openchamber-switch-live-');
    folders.push(folder);
    const dataDir = path.join(folder, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    // The server copies `projects`, `themes` and `speech-models` from the default data directory
    // into a fresh one at start; the last of those can be gigabytes. Present and empty, they stay.
    for (const entry of ['projects', 'themes', 'speech-models']) fs.mkdirSync(path.join(dataDir, entry));
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ isolatedSpacesEnabled: enabled }));
    const daemon = await startFakeDaemon(folder);
    const server = await startServer({ dataDir, dockerHost: daemon.host, port: await freePort() });
    return { dataDir, daemon, server, stop: async () => { await server.stop(); await daemon.stop(); } };
  };

  it('registers no route of the feature and never speaks to Docker while the switch is off', async () => {
    const run = await startWith(false);
    try {
      const prefixed = await run.server.get('/api/spaces/aaaaaaaaaaaa/session');
      // Whatever the host answers, it is not the feature: no space code, and the request went on
      // to the host's own routes.
      const body = await prefixed.text();
      expect(body).not.toMatch(/space_not_found|space_unreachable|host_only_route/);
      const unguarded = await run.server.get('/api/git/status?directory=/spaces/aaaaaaaaaaaa/repo');
      expect(unguarded.status).not.toBe(400);
      expect(run.daemon.connections()).toBe(0);
      expect(fs.existsSync(path.join(run.dataDir, 'spaces'))).toBe(false);
    } finally {
      await run.stop();
    }
  }, 120_000);

  it('registers the routes and asks Docker for its spaces while the switch is on', async () => {
    const run = await startWith(true);
    try {
      const prefixed = await run.server.get('/api/spaces/aaaaaaaaaaaa/session');
      expect(prefixed.status).toBe(502);
      expect(await prefixed.json()).toMatchObject({ code: 'space_unreachable' });
      expect(run.daemon.connections()).toBeGreaterThan(0);
      const guarded = await run.server.get('/api/git/status?directory=/spaces/aaaaaaaaaaaa/repo');
      expect(guarded.status).toBe(400);
      expect(await guarded.json()).toMatchObject({ code: 'space_directory_needs_prefix' });
      const hostOnly = await run.server.get('/api/spaces/aaaaaaaaaaaa/config/settings');
      expect(hostOnly.status).toBe(403);
      expect(fs.existsSync(path.join(run.dataDir, 'spaces', 'owner'))).toBe(true);
    } finally {
      await run.stop();
    }
  }, 120_000);
});
