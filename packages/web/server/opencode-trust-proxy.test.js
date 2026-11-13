import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import os from 'os';
import path from 'path';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';

import { registerOpenCodeProxy } from './lib/opencode/proxy.js';
import { createOpenCodeTrust, OPENCODE_TRUST_REQUIRED } from './lib/opencode-trust/index.js';

const listen = (app) => new Promise((resolve, reject) => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
  server.once('error', reject);
});

const close = (server) => new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));

describe('OpenCode proxy folder trust', () => {
  let root;
  let repo;
  let upstreamServer;
  let proxyServer;
  let base;
  let plain;
  let upstreamHits;
  let upstreamBodies;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'opencode-trust-proxy-')));
    repo = path.join(root, 'repo');
    await mkdir(path.join(repo, '.opencode', 'plugins'), { recursive: true });
    await writeFile(path.join(repo, '.opencode', 'plugins', 'probe.js'), 'export default {}');
    plain = path.join(root, 'plain');
    await mkdir(path.join(plain, 'sub'), { recursive: true });
    upstreamHits = [];
    upstreamBodies = [];

    const upstream = express();
    upstream.get('/api/session/:id', (req, res) => {
      if (req.params.id === 'ses_repo') return res.json({ data: { id: 'ses_repo', location: { directory: repo } } });
      if (req.params.id === 'ses_plain') return res.json({ data: { id: 'ses_plain', location: { directory: plain } } });
      return res.status(404).json({ error: 'not found' });
    });
    upstream.use(express.json());
    upstream.use((req, res) => {
      upstreamHits.push(`${req.method} ${req.path}`);
      if (req.method === 'POST') upstreamBodies.push(req.body);
      res.json({ ok: true });
    });
    upstreamServer = await listen(upstream);
    const upstreamPort = upstreamServer.address().port;

    const app = express();
    // As in the server: OpenCode routes reach the proxy with their body unread.
    app.use('/api/opencode', express.json());
    registerOpenCodeProxy(app, {
      fs: {},
      os: {},
      path,
      OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({ openCodePort: upstreamPort, isOpenCodeReady: true, openCodeNotReadySince: 0, isRestartingOpenCode: false }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (requestPath) => `http://127.0.0.1:${upstreamPort}${requestPath}`,
      ensureOpenCodeApiPrefix: () => {},
      readWorktreeBootstrapStatus: async () => ({ status: 'ready' }),
      waitForWorktreeRemovalToSettle: async () => {},
      openCodeTrust: createOpenCodeTrust({ storePath: path.join(root, 'opencode-trust.json'), homeDirectory: path.join(root, 'home') }),
    });
    proxyServer = await listen(app);
    base = `http://127.0.0.1:${proxyServer.address().port}`;
  });

  afterEach(async () => {
    await close(proxyServer);
    await close(upstreamServer);
    await rm(root, { recursive: true, force: true });
  });

  const scoped = () => ({ 'x-opencode-directory': encodeURIComponent(repo) });

  it('keeps OpenCode away from an untrusted folder until the user trusts it', async () => {
    const refused = await fetch(`${base}/api/agent`, { headers: scoped() });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: OPENCODE_TRUST_REQUIRED, directory: repo });
    expect(upstreamHits).toEqual([]);

    const shown = await (await fetch(`${base}/api/opencode/trust?directory=${encodeURIComponent(repo)}`)).json();
    expect(shown).toMatchObject({ trusted: false, items: [{ kind: 'plugin', source: '.opencode/plugins/probe.js' }] });
    const answered = await fetch(`${base}/api/opencode/trust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: repo, fingerprint: shown.fingerprint }),
    });
    expect(answered.status).toBe(200);

    expect((await fetch(`${base}/api/agent`, { headers: scoped() })).status).toBe(200);
    expect(upstreamHits).toEqual(['GET /api/agent']);
  });

  it('checks the folder a session runs in, whatever folder the request names', async () => {
    const prompt = await fetch(`${base}/api/session/ses_repo/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(prompt.status).toBe(403);
    expect(upstreamHits).toEqual([]);

    expect((await fetch(`${base}/api/session/ses_other/prompt`, { method: 'POST' })).status).toBe(200);
  });

  it('serves the session list of an untrusted folder', async () => {
    expect((await fetch(`${base}/api/session?limit=5`, { headers: scoped() })).status).toBe(200);
  });

  const move = (sessionID, directory) => fetch(`${base}/api/session/${sessionID}/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directory }),
  });

  it('keeps a session out of an untrusted folder until the user trusts it', async () => {
    const refused = await move('ses_plain', repo);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: OPENCODE_TRUST_REQUIRED, directory: repo });
    expect(upstreamHits).toEqual([]);

    const shown = await (await fetch(`${base}/api/opencode/trust?directory=${encodeURIComponent(repo)}`)).json();
    await fetch(`${base}/api/opencode/trust`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: repo, fingerprint: shown.fingerprint }),
    });
    expect((await move('ses_plain', repo)).status).toBe(200);
    expect(upstreamHits).toEqual(['POST /api/session/ses_plain/move']);
    expect(upstreamBodies).toEqual([{ directory: repo }]);
  });

  it('moves a session between folders that run nothing', async () => {
    const moved = await fetch(`${base}/api/session/ses_plain/move`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory: path.join(plain, 'sub'), delivery: 'queue' }),
    });
    expect(moved.status).toBe(200);
    expect(upstreamBodies).toEqual([{ directory: path.join(plain, 'sub'), delivery: 'queue' }]);
  });
});
