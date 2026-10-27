import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import express from 'express';
import { expect, it } from 'vitest';
import { OpenCode } from '@opencode/client';
import { createAccountRotationRuntime } from './runtime.js';
import { materializeRotationPlugin, registerRotationPluginRoute } from './plugin.js';

// Opt-in native OpenCode probe. Uses a local fake provider and isolated config,
// data, and home directories. Never reads or switches the user's saved accounts.
it.skipIf(!process.env.OPENCHAMBER_ROTATION_TEST_BINARY).each(['recover', 'exhausted', 'stop'])('native OpenCode recovery: %s', async (mode) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'rotation-native-'));
  const servers = [];
  let child;
  let client;
  const listen = async (app) => {
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${server.address().port}`;
  };
  let active = 'a';
  let rotations = 0;
  let primaryRequests = 0;
  let notices = 0;
  const credentialsUsed = [];
  let logs = '';
  let releaseActivation = () => {};
  let activationStarted = () => {};
  const activation = new Promise((resolve) => { activationStarted = resolve; });
  const activationReleased = new Promise((resolve) => { releaseActivation = resolve; });
  const headers = { Authorization: `Basic ${Buffer.from('opencode:probe-password').toString('base64')}` };
  try {
    const provider = express();
    provider.use(express.json());
    provider.post(/.*/, (req, res) => {
      const primary = req.headers['x-rotation-primary'] === '1';
      if (primary) { primaryRequests++; credentialsUsed.push(req.headers.authorization); }
      if (primary && (active === 'a' || mode === 'exhausted')) return res.status(429).json({ error: { type: 'usage_limit_reached', message: "You've hit your usage limit" } });
      const chunk = { id: 'probe', object: 'chat.completion.chunk', created: 1, model: 'rotation-test', choices: [{ index: 0, delta: { role: 'assistant', content: 'Recovered.' }, finish_reason: null }] };
      res.type('text/event-stream');
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    });
    const providerUrl = await listen(provider);
    const accounts = {
      list: async () => [active, ...['a', 'b'].filter((id) => id !== active)].map((id) => ({ id, label: id, type: 'credential', method: 'oauth' })),
      activate: async (id) => {
        activationStarted();
        if (mode === 'stop') await activationReleased;
        await client.credential.activate({ credentialID: id });
        active = id;
        rotations++;
      },
    };
    const runtime = createAccountRotationRuntime({ dataDir: directory, accounts });
    await runtime.save('openai', { enabled: true }, directory);
    const callback = express();
    registerRotationPluginRoute(callback, { express, runtime, authorize: (req) => req.headers.authorization === 'Bearer probe-token', broadcast: () => { notices++; } });
    const callbackUrl = await listen(callback);
    const plugin = await materializeRotationPlugin(directory);
    const marker = path.join(directory, 'marker');
    await fs.mkdir(marker);
    await fs.writeFile(path.join(marker, 'package.json'), JSON.stringify({ name: 'rotation-probe-marker', type: 'module', main: './index.js' }));
    await fs.writeFile(path.join(marker, 'index.js'), `export default { id: 'rotation-probe-marker', async setup(ctx) {
      await ctx.session.hook('model.request', event => {
        event.baseURL = ${JSON.stringify(`${providerUrl}/v1`)};
        if (event.kind === 'primary') event.headers['x-rotation-primary'] = '1';
      });
    } };`);
    const config = path.join(directory, 'opencode.json');
    await fs.writeFile(config, JSON.stringify({
      plugins: [plugin, marker], model: 'openai/rotation-test', update: 'disable',
      providers: { openai: { package: '@opencode/ai/providers/openai-compatible', settings: { baseURL: `${providerUrl}/v1` },
        models: { 'rotation-test': { name: 'Rotation test', limit: { context: 8192, output: 128 } } } } },
    }));
    const reservation = http.createServer();
    const reservedUrl = await listen(reservation);
    const port = new URL(reservedUrl).port;
    await new Promise((resolve) => reservation.close(resolve));
    servers.splice(servers.indexOf(reservation), 1);
    child = spawn(process.env.OPENCHAMBER_ROTATION_TEST_BINARY, ['serve', '--hostname', '127.0.0.1', '--port', port], {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, XDG_CONFIG_HOME: path.join(directory, 'config'),
        XDG_DATA_HOME: path.join(directory, 'data'), XDG_CACHE_HOME: path.join(directory, 'cache'), XDG_STATE_HOME: path.join(directory, 'state'),
        OPENCODE_CONFIG: config, OPENCODE_SERVER_PASSWORD: 'probe-password', OPENCHAMBER_AGENT_TOOL_URL: `${callbackUrl}/api/openchamber/agent-tool`, OPENCHAMBER_AGENT_TOOL_TOKEN: 'probe-token' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const captureLog = (data) => { logs += String(data).replace(/server password .*/g, 'server password [redacted]'); };
    child.stdout.on('data', captureLog);
    child.stderr.on('data', captureLog);
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${reservedUrl}/api/info`, { headers }).then((response) => response.ok).catch(() => false)) { ready = true; break; }
      if (child.exitCode !== null) throw new Error(logs);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`OpenCode did not start: ${logs}`);
    client = OpenCode.make({ baseUrl: reservedUrl, headers: { ...headers, 'x-opencode-directory': encodeURIComponent(directory) } });
    // Synthetic key credentials verify native credential refresh. The adapter's
    // OAuth metadata is a test seam; no real subscription sign-in is involved.
    await client.credential.create({ id: 'a', integrationID: 'openai', value: { type: 'key', key: 'probe-a' }, activate: true });
    await client.credential.create({ id: 'b', integrationID: 'openai', value: { type: 'key', key: 'probe-b' }, activate: false });
    const session = await client.session.create({ model: { providerID: 'openai', id: 'rotation-test' } });
    await client.session.prompt({ sessionID: session.id, text: 'Reply with Recovered.' });
    if (mode === 'stop') {
      await activation;
      await client.session.interrupt({ sessionID: session.id });
      releaseActivation();
    }
    await client.session.wait({ sessionID: session.id });
    const messages = await client.message.list({ sessionID: session.id });
    const answer = messages.data.find((message) => message.type === 'assistant' && message.content.some((part) => part.type === 'text' && part.text.includes('Recovered.')));
    if (mode === 'recover') expect(answer, JSON.stringify({ messages, rotations, primaryRequests, logs })).toBeDefined();
    else expect(answer).toBeUndefined();
    if (mode === 'exhausted') expect(messages.data.find((message) => message.type === 'idle')?.error?.message).toContain('usage limit');
    // A callback already awaiting activation may complete after interruption.
    for (let i = 0; i < 50 && rotations === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rotations).toBe(1);
    expect(primaryRequests).toBe(mode === 'stop' ? 1 : 2);
    expect(credentialsUsed).toEqual(mode === 'stop' ? ['Bearer probe-a'] : ['Bearer probe-a', 'Bearer probe-b']);
    if (mode !== 'stop') expect(notices).toBe(1);
  } finally {
    releaseActivation();
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    await fs.rm(directory, { recursive: true, force: true });
  }
}, 30_000);
