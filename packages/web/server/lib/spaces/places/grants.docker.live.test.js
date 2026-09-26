// Grants on a real space, made through the journey on a real Docker daemon. Runs only with
// OPENCHAMBER_TEST_DOCKER=1. A real key goes behind the window of a space made through the
// journey's own routes; a stand-in provider on the space's outer network answers with the hash
// of the key it saw and never with the key; and the key is then looked for everywhere the host
// and the space keep things: the record on disk, the metadata of both containers, the space's
// environment, processes and files. OpenCode inside is asked for a turn against that provider,
// which proves that the provider configuration the host wrote sends it through the window.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createGlobalMessageStreamHub } from '../../event-stream/global-hub.js';
import { registerOpenCodeProxy } from '../../opencode/proxy.js';
import { runCommand } from '../run-command.js';
import { createSpacesHost } from '../host.js';
import { SPACE_OPENCODE_CONFIG_PATH } from '../layout.js';
import { LIVE_DOCKER_ENABLED, createLiveDockerPlace } from './docker-live-support.js';

const CREATE_TIMEOUT_MS = 25 * 60_000;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const until = async (check, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await check()) && Date.now() < deadline) await sleep(250);
  return check();
};
const listen = (app) => new Promise((resolve) => {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const sha256 = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const temporary = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

describe.skipIf(!LIVE_DOCKER_ENABLED)('grants on a real space: docker (live)', () => {
  // Two real keys, made here. Neither ever enters the space; the stand-in provider sees them.
  const TYPED_KEY = `sk-ant-live-${crypto.randomBytes(24).toString('hex')}`;
  const ENV_KEY = `sk-oai-live-${crypto.randomBytes(24).toString('hex')}`;
  let place;
  let dispose = async () => {};
  let liveHost;
  let dataDir;
  let project;
  let host;
  let hub;
  let hostOpenCode;
  let server;
  let spaceId;
  let upstream = { seen: async () => [], stop: async () => {} };
  let session = null;
  const url = (suffix) => `http://127.0.0.1:${server.address().port}${suffix}`;
  const inside = async (argv) => place.exec(spaceId, argv, { timeoutMs: 60_000 });
  const shell = (script) => inside(['sh', '-c', script]);
  const prefixed = (suffix, init) => fetch(url(`/api/spaces/${spaceId}${suffix}`), init);
  const json = (body) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const listed = async () => (await host.journey.listSpaces({ access: true })).find((space) => space.id === spaceId);
  const recordText = () => fs.readFileSync(path.join(dataDir, 'spaces', 'records', `${spaceId}.json`), 'utf8');

  beforeAll(async () => {
    ({ place, dispose, host: liveHost } = createLiveDockerPlace());
    dataDir = temporary('openchamber-grants-live-');
    // The registered project the space is made for: a small repository of its own.
    project = temporary('openchamber-grants-project-');
    const git = (...args) => runCommand('git', ['-C', project, ...args]);
    await git('init', '-q', '.');
    fs.writeFileSync(path.join(project, 'README.md'), 'A project for the grants live pass.\n');
    await git('add', '.');
    await git('-c', 'user.email=me@example.invalid', '-c', 'user.name=Me', 'commit', '-q', '-m', 'init');

    host = createSpacesHost({
      dataDir,
      place,
      listProjectDirectories: async () => [project],
      hostEnvironment: { ...process.env, OPENAI_API_KEY: ENV_KEY },
      logger: { warn: () => {} },
    });
    // The host's own OpenCode: nothing but an event stream that stays open.
    const hostApp = express();
    hostApp.get('/api/session', (_req, res) => res.json({ data: [], cursor: {} }));
    hostApp.get('/api/event', (_req, res) => { res.setHeader('content-type', 'text/event-stream'); res.flushHeaders(); });
    hostOpenCode = await listen(hostApp);
    const hostPort = hostOpenCode.address().port;
    hub = createGlobalMessageStreamHub({ buildOpenCodeUrl: (p) => `http://127.0.0.1:${hostPort}${p}`, getOpenCodeAuthHeaders: () => ({}), deltaCoalesceWindowMs: 0 });
    const app = express();
    app.use(host.middleware);
    registerOpenCodeProxy(app, {
      fs: {}, os: {}, path, OPEN_CODE_READY_GRACE_MS: 0,
      getRuntime: () => ({ openCodePort: hostPort, isOpenCodeReady: true, openCodeNotReadySince: 0, isRestartingOpenCode: false }),
      getOpenCodeAuthHeaders: () => ({}),
      buildOpenCodeUrl: (p) => `http://127.0.0.1:${hostPort}${p}`,
      ensureOpenCodeApiPrefix: () => {},
      mergeSpaceSessionList: (payload) => host.mergeSessionList(payload),
      spaceEventHub: hub,
    });
    server = await listen(app);
    await host.startEvents(hub);

    // The space, through the journey, as the create dialog will make it.
    const answer = await host.journey.createSpace({ projectDirectory: project, name: 'Grants live', start: 'clean', network: { mode: 'allowlist', domains: [] } });
    spaceId = answer.id;
    expect(await until(async () => (await listed())?.state === 'running' && (await listed())?.step === null, CREATE_TIMEOUT_MS)).toBe(true);
    upstream = await liveHost.startWindowUpstream(spaceId);
  }, CREATE_TIMEOUT_MS);

  afterAll(async () => {
    host?.close();
    hub?.stop();
    for (const running of [server, hostOpenCode]) {
      await new Promise((resolve) => { if (running) { running.closeAllConnections?.(); running.close(() => resolve()); } else resolve(); });
    }
    await upstream.stop();
    await dispose();
    for (const folder of [dataDir, project]) if (folder) fs.rmSync(folder, { recursive: true, force: true });
  });

  it('gives a typed key to the gatekeeper and keeps it out of the record, the containers and the space', async () => {
    const granted = await host.journey.grantAccess(spaceId, { kind: 'model', provider: 'anthropic', upstream: upstream.url, secret: { kind: 'typed', value: TYPED_KEY } });
    expect(granted.grant).toMatchObject({ id: 'anthropic', header: 'x-api-key', source: { kind: 'typed' }, url: 'http://gatekeeper:8080/model/anthropic' });
    expect(JSON.stringify(granted)).not.toContain(TYPED_KEY);

    // The window carries the real key: a request from inside reaches the stand-in with its hash.
    const through = await shell('curl -s -H "x-api-key: space-window" http://gatekeeper:8080/model/anthropic/messages');
    expect(through.code, through.stderr).toBe(0);
    expect(JSON.parse(through.stdout)).toMatchObject({ path: '/v1/messages', apiKey: sha256(TYPED_KEY), authorization: 'none' });

    // Not on the host's disk.
    expect(recordText()).not.toContain(TYPED_KEY);
    expect(JSON.parse(recordText()).grants).toEqual([{ kind: 'model', id: 'anthropic', provider: 'anthropic', upstream: upstream.url, header: 'x-api-key', source: { kind: 'typed' } }]);
    // Not in what the runtime records about either container.
    expect(await liveHost.spaceMetadata(spaceId)).not.toContain(TYPED_KEY);
    expect(await liveHost.gatekeeperMetadata(spaceId)).not.toContain(TYPED_KEY);
    // Not anywhere the space can look. The space prints what it has; the host searches it.
    const insideTheSpace = await shell(`env; ps auxeww; find /home/space /tmp /spaces/${spaceId} -type f -size -1M -exec cat {} + 2>/dev/null; true`);
    expect(insideTheSpace.stdout.length).toBeGreaterThan(0);
    expect(insideTheSpace.stdout).not.toContain(TYPED_KEY);
    // What the space does have: the configuration that points OpenCode at the window.
    const config = JSON.parse((await inside(['cat', SPACE_OPENCODE_CONFIG_PATH])).stdout);
    expect(config.provider.anthropic.options).toEqual({ baseURL: 'http://gatekeeper:8080/model/anthropic', apiKey: 'space-window' });
    expect((await listed())).toMatchObject({ access: 'granted', needsAccess: [], grants: [expect.objectContaining({ id: 'anthropic' })] });
  }, 120_000);

  it('sends a turn of OpenCode inside through the window, where the stand-in sees the real key', async () => {
    const directory = (await listed()).directory;
    const created = await prefixed('/session', json({ location: { directory }, title: 'Through the window' }));
    expect(created.status, await created.clone().text()).toBe(200);
    session = (await created.json()).data;
    const model = await prefixed(`/session/${session.id}/model`, { ...json({ model: { id: 'claude-sonnet-4-5', providerID: 'anthropic' } }), headers: { 'content-type': 'application/json', 'x-opencode-directory': encodeURIComponent(directory) } });
    expect(model.status, await model.clone().text()).toBeLessThan(300);
    const prompt = await prefixed(`/session/${session.id}/prompt`, { ...json({ id: `msg_${crypto.randomBytes(8).toString('hex')}`, text: 'Say hello.' }), headers: { 'content-type': 'application/json', 'x-opencode-directory': encodeURIComponent(directory) } });
    expect(prompt.status, await prompt.clone().text()).toBeLessThan(300);

    // A POST: the curl of the test above was a GET with the same key, and this must be OpenCode's own request.
    const fromOpenCode = (entry) => entry.method === 'POST' && entry.apiKey === sha256(TYPED_KEY) && entry.path.startsWith('/v1/messages');
    expect(await until(async () => (await upstream.seen()).some(fromOpenCode), 120_000)).toBe(true);
    expect((await upstream.seen()).find(fromOpenCode)).toMatchObject({ authorization: 'none' });
    expect(JSON.stringify(await upstream.seen())).not.toContain(TYPED_KEY);
  }, 180_000);

  it('measures whether OpenCode inside takes a provider granted after its instance started', async () => {
    // A second provider, from the host's environment this time, granted while the instance of
    // the space's project is already running. Whether that instance re-reads its configuration
    // without a restart is what this measures; the outcome is reported, not asserted, because
    // either way the key is out of the space and the window is the only way to the provider.
    const granted = await host.journey.grantAccess(spaceId, { kind: 'model', provider: 'openai', upstream: upstream.url, secret: { kind: 'env', name: 'OPENAI_API_KEY' } });
    expect(granted.grant).toMatchObject({ id: 'openai', header: 'authorization', source: { kind: 'env', name: 'OPENAI_API_KEY' } });
    expect(recordText()).not.toContain(ENV_KEY);
    const directory = (await listed()).directory;
    const headers = { 'content-type': 'application/json', 'x-opencode-directory': encodeURIComponent(directory) };
    await prefixed(`/session/${session.id}/model`, { ...json({ model: { id: 'gpt-4.1', providerID: 'openai' } }), headers });
    await prefixed(`/session/${session.id}/prompt`, { ...json({ id: `msg_${crypto.randomBytes(8).toString('hex')}`, text: 'Say hello again.' }), headers });
    const arrived = await until(async () => (await upstream.seen()).some((seen) => seen.authorization === sha256(`Bearer ${ENV_KEY}`)), 60_000);
    // stderr, because vitest keeps a passing test's console.log to itself.
    process.stderr.write(`[grants live] a provider granted after the instance started ${arrived ? 'was used on the next turn without a restart' : 'was NOT used on the next turn: the instance keeps the configuration it started with'}\n`);
    expect(JSON.stringify(await upstream.seen())).not.toContain(ENV_KEY);
  }, 180_000);

  it('says the grants again after a stop and a start: the environment key yes, the typed key no', async () => {
    await host.journey.stopSpace(spaceId);
    const started = await host.journey.startSpace(spaceId);
    expect(started).toMatchObject({ state: 'running', networkRestored: true, grantsRestored: ['openai'], needsAccess: ['anthropic'] });
    expect(await listed()).toMatchObject({ access: 'needs_access', needsAccess: ['anthropic'] });
    // The environment key works again at once; the typed one is gone with the gatekeeper's memory.
    const bearer = await shell('curl -s http://gatekeeper:8080/model/openai/responses');
    expect(JSON.parse(bearer.stdout)).toMatchObject({ path: '/v1/responses', authorization: sha256(`Bearer ${ENV_KEY}`) });
    const missing = await shell('curl -s -o /dev/null -w "%{http_code}" http://gatekeeper:8080/model/anthropic/messages');
    expect(missing.stdout).toBe('403');
    // Granting once more brings it back.
    await host.journey.grantAccess(spaceId, { kind: 'model', provider: 'anthropic', upstream: upstream.url, secret: { kind: 'typed', value: TYPED_KEY } });
    expect(await listed()).toMatchObject({ access: 'granted', needsAccess: [] });
    expect(recordText()).not.toContain(TYPED_KEY);
    expect(recordText()).not.toContain(ENV_KEY);
  }, 300_000);
});
