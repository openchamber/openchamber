import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createMcpOAuthSignIn, isSameMachineUrl } from './mcp-oauth.js';
import { normalizeForwardedDirectoryHeaders } from './proxy.js';

const CALLBACK = '/api/mcp/oauth/docs/callback';
const START = '/api/integration/mcp_abc/connect/oauth';
const REMOTE_ORIGIN = 'https://chamber.example.com';
const OWN_REDIRECT = `${REMOTE_ORIGIN}${CALLBACK}`;
const OFF_MACHINE_URL = 'http://opencode.internal:4096/';

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
};

/**
 * OpenCode as the route sees it: an integration, and an OAuth start that opens
 * a listener on the configured port and fails the attempt on a wrong state.
 */
const startFakeOpenCode = async ({ config, servers }) => {
  const opencode = {
    starts: 0,
    cancelled: [],
    directoryHeaders: [],
    failed: false,
    completed: [],
    listenerHits: 0,
    staleStarts: 0,
    listener: null,
  };

  const closeListener = async () => {
    if (!opencode.listener) return;
    const listener = opencode.listener;
    opencode.listener = null;
    await new Promise((resolve) => listener.close(resolve));
  };

  const openListener = async (oauth, state) => {
    const redirectPath = oauth.redirect_uri ? new URL(oauth.redirect_uri).pathname : '/callback';
    const listener = http.createServer((req, res) => {
      opencode.listenerHits += 1;
      if (opencode.listenerRedirect) {
        return res.writeHead(302, { location: opencode.listenerRedirect }).end();
      }
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== redirectPath) return res.writeHead(404).end('Not found');
      if (url.searchParams.get('state') !== state) {
        opencode.failed = true;
        return res.writeHead(400).end('OAuth state mismatch');
      }
      opencode.completed.push(req.url);
      res.setHeader('content-type', 'text/html');
      return res.end('<p>done</p>');
    });
    servers.push(listener);
    await new Promise((resolve) => listener.listen(oauth.callback_port ?? 0, '127.0.0.1', resolve));
    opencode.listener = listener;
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://opencode.test');
    opencode.directoryHeaders.push(req.headers['x-opencode-directory']);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && url.pathname === '/api/integration/mcp_abc') {
      return res.end(JSON.stringify({ data: { id: 'mcp_abc', name: 'docs', metadata: { source: 'mcp' } } }));
    }
    if (req.method === 'DELETE') {
      opencode.cancelled.push(url.pathname.split('/').pop());
      await closeListener();
      res.statusCode = 204;
      return res.end();
    }
    opencode.starts += 1;
    const attemptID = `attempt-${opencode.starts}`;
    const state = `state-${opencode.starts}`;
    const oauth = opencode.staleStarts > 0 ? {} : config.entry.oauth ?? {};
    if (opencode.staleStarts > 0) opencode.staleStarts -= 1;
    await openListener(oauth, state);
    const redirect = oauth.redirect_uri ?? `http://127.0.0.1:${opencode.listener.address().port}/callback`;
    const authorization = new URL('https://provider.example.com/authorize');
    authorization.searchParams.set('redirect_uri', redirect);
    authorization.searchParams.set('state', state);
    return res.end(JSON.stringify({
      data: {
        attemptID,
        url: authorization.toString(),
        mode: 'auto',
        instructions: 'go',
        paste: opencode.paste,
        time: { created: 1, expires: opencode.expires ?? Date.now() + 60_000 },
      },
    }));
  });
  servers.push(server);
  opencode.port = await listen(server);
  return opencode;
};

describe('isSameMachineUrl', () => {
  it('accepts loopback and this machine\'s own addresses', () => {
    expect(isSameMachineUrl('http://127.0.0.1:4096/', [])).toBe(true);
    expect(isSameMachineUrl('http://localhost:4096/', [])).toBe(true);
    expect(isSameMachineUrl('http://[::1]:4096/', [])).toBe(true);
    expect(isSameMachineUrl('http://192.168.1.10:4096/', ['192.168.1.10'])).toBe(true);
    expect(isSameMachineUrl('http://[fd00::1]:4096/', ['fd00::1'])).toBe(true);
  });

  it('treats anything else as another machine', () => {
    expect(isSameMachineUrl('http://192.168.1.20:4096/', ['192.168.1.10'])).toBe(false);
    expect(isSameMachineUrl('http://opencode.internal:4096/', [])).toBe(false);
    expect(isSameMachineUrl('not a url', [])).toBe(false);
  });
});

describe('MCP OAuth sign-in', () => {
  let storeDir;
  let storePath;
  let servers;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-'));
    storePath = path.join(storeDir, 'assignments.json');
    servers = [];
  });

  afterEach(async () => {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  const writeAssignments = (assignments) => {
    fs.writeFileSync(storePath, JSON.stringify({ assignments }));
  };

  const build = async ({ entry, others = [], baseUrl, signInOptions = {} }) => {
    const config = { entry, others, updates: [], directory: '/repo' };
    const opencode = await startFakeOpenCode({ config, servers });
    const signIn = createMcpOAuthSignIn({
      storePath,
      buildOpenCodeUrl: (target) => (target === '/' && baseUrl ? baseUrl : `http://127.0.0.1:${opencode.port}${target}`),
      getOpenCodeAuthHeaders: () => ({}),
      resolveProjectDirectory: async (req) => {
        config.resolvedFrom = req.get('x-opencode-directory');
        return { directory: config.directory, error: config.directoryError };
      },
      getMcpConfig: () => config.entry,
      listMcpConfigs: () => [config.entry, ...config.others],
      updateMcpConfig: (name, updates, directory) => {
        config.updates.push({ name, updates, directory });
        config.entry = { ...config.entry, ...updates };
      },
      configPickupRetryMs: 1,
      ...signInOptions,
    });
    const app = express();
    app.use(express.json());
    // The checkout gate in front of these routes does this in the proxy.
    app.use((req, _res, next) => {
      normalizeForwardedDirectoryHeaders(req.headers);
      next();
    });
    signIn.registerCallbackRoute(app);
    signIn.registerStartRoutes(app, { readBody: async () => undefined });
    // What the generic proxy would have answered.
    app.use('/api', (_req, res) => res.status(299).json({ proxied: true }));
    return { app, config, opencode };
  };

  const remoteEntry = (oauth) => ({ name: 'docs', type: 'remote', url: 'https://mcp.example.com', oauth });

  const startFromRemote = (app) => request(app)
    .post(START)
    .set('Host', 'chamber.example.com')
    .set('X-Forwarded-Proto', 'https')
    .send({ methodID: 'mcp_abc' });

  describe('start', () => {
    it('prepares an existing entry with no oauth block and binds the attempt', async () => {
      const { app, config, opencode } = await build({ entry: remoteEntry() });

      const response = await startFromRemote(app).expect(200);

      expect(response.body.data.attemptID).toBe('attempt-1');
      expect(config.updates).toHaveLength(1);
      expect(config.entry.oauth.redirect_uri).toBe(OWN_REDIRECT);
      expect(Number.isInteger(config.entry.oauth.callback_port)).toBe(true);
      expect(opencode.listener.address().port).toBe(config.entry.oauth.callback_port);
    });

    it('keeps the other oauth fields of the entry it prepares', async () => {
      const { app, config } = await build({ entry: remoteEntry({ client_id: 'id', scope: 'read' }) });
      await startFromRemote(app).expect(200);
      expect(config.entry.oauth).toMatchObject({ client_id: 'id', scope: 'read', redirect_uri: OWN_REDIRECT });
    });

    it('sends a non-Latin-1 directory the way OpenCode decodes it', async () => {
      const { app, opencode } = await build({ entry: remoteEntry() });
      await startFromRemote(app).set('x-opencode-directory', encodeURIComponent('/проєкт')).set('x-opencode-directory-encoding', 'uri').expect(200);
      expect(decodeURIComponent(opencode.directoryHeaders[0])).toBe('/проєкт');
    });

    it('reads the directory the SDK sends, encoded and unmarked, the way OpenCode does', async () => {
      const { app, config, opencode } = await build({ entry: remoteEntry() });

      await startFromRemote(app).set('x-opencode-directory', '%2Frepo').expect(200);

      expect(config.resolvedFrom).toBe('/repo');
      expect(new Set(opencode.directoryHeaders)).toEqual(new Set(['%2Frepo']));
    });

    it('prefers a location query over the header, as OpenCode does', async () => {
      const { app, config } = await build({ entry: remoteEntry() });

      await request(app)
        .post(`${START}?location%5Bdirectory%5D=%2Fother`)
        .set('Host', 'chamber.example.com')
        .set('X-Forwarded-Proto', 'https')
        .set('x-opencode-directory', '%2Frepo')
        .send({})
        .expect(200);

      expect(config.resolvedFrom).toBe('/other');
    });

    it('keeps a malformed directory as it is, as OpenCode does', async () => {
      const { app, config, opencode } = await build({ entry: remoteEntry() });

      await startFromRemote(app).set('x-opencode-directory', '/repo%zz').expect(200);

      expect(config.resolvedFrom).toBe('/repo%zz');
      expect(decodeURIComponent(opencode.directoryHeaders[0])).toBe('/repo%zz');
    });

    it('refuses a named directory it cannot resolve instead of reading global config', async () => {
      const { app, config, opencode } = await build({ entry: remoteEntry() });
      config.directory = null;
      config.directoryError = 'Directory not found';

      const response = await startFromRemote(app).set('x-opencode-directory', '%2Fgone').expect(400);

      expect(response.body.message).toBe('Directory not found');
      expect(opencode.starts).toBe(0);
    });

    it('leaves a global server signing in with no project alone', async () => {
      const { app, config } = await build({ entry: remoteEntry() });
      config.directory = null;
      config.directoryError = 'Directory parameter or active project is required';

      await startFromRemote(app).expect(200);
    });

    it('keeps a custom redirect saved while the port was being allocated', async () => {
      const custom = { redirect_uri: 'https://proxy.example.com/cb' };
      const built = await build({
        entry: remoteEntry(),
        signInOptions: {
          allocatePort: async () => {
            built.config.entry = remoteEntry(custom);
            return 41005;
          },
        },
      });

      await startFromRemote(built.app).expect(299);

      expect(built.config.updates).toEqual([]);
      expect(built.config.entry.oauth).toEqual(custom);
      expect(fs.existsSync(storePath)).toBe(false);
      expect(built.opencode.starts).toBe(0);
    });

    it('stops preparing a server that was turned off or deleted meanwhile', async () => {
      const built = await build({
        entry: remoteEntry(),
        signInOptions: {
          allocatePort: async () => {
            built.config.entry = null;
            return 41006;
          },
        },
      });

      await startFromRemote(built.app).expect(299);

      expect(built.config.updates).toEqual([]);
    });

    it('prepares from the new entry when an unrelated save lands during preparation', async () => {
      let allocations = 0;
      const built = await build({
        entry: remoteEntry({ scope: 'read' }),
        signInOptions: {
          allocatePort: async () => {
            allocations += 1;
            if (allocations === 1) built.config.entry = remoteEntry({ scope: 'write' });
            return 41007;
          },
        },
      });

      await startFromRemote(built.app).expect(200);

      expect(built.config.updates).toHaveLength(1);
      expect(built.config.entry.oauth).toEqual({ scope: 'write', redirect_uri: OWN_REDIRECT, callback_port: 41007 });
    });

    it('gives up with an error when the entry keeps changing', async () => {
      let saves = 0;
      const built = await build({
        entry: remoteEntry(),
        signInOptions: {
          allocatePort: async () => {
            saves += 1;
            built.config.entry = remoteEntry({ scope: `save-${saves}` });
            return 41008;
          },
        },
      });

      const response = await startFromRemote(built.app).expect(503);

      expect(response.body.message).toMatch(/kept changing/);
      expect(built.config.updates).toEqual([]);
    });

    it('leaves oauth:false and local servers to the proxy', async () => {
      const off = await build({ entry: remoteEntry(false) });
      await startFromRemote(off.app).expect(299);
      const local = await build({ entry: { name: 'docs', type: 'local', command: ['x'] } });
      await startFromRemote(local.app).expect(299);
      expect(off.config.updates).toEqual([]);
      expect(local.config.updates).toEqual([]);
    });

    it('leaves an integration that is not an MCP server to the proxy', async () => {
      const { app, opencode } = await build({ entry: remoteEntry() });
      await request(app).post('/api/integration/openai/connect/oauth').send({}).expect(299);
      expect(opencode.starts).toBe(0);
    });

    it('leaves a browser on the OpenCode machine to OpenCode\'s own redirect', async () => {
      const { app, config, opencode } = await build({ entry: remoteEntry() });
      await request(app).post(START).set('Host', 'localhost:3000').send({}).expect(299);
      expect(config.updates).toEqual([]);
      expect(opencode.starts).toBe(0);
    });

    it.each([
      ['a custom redirect with an explicit port', { redirect_uri: 'https://proxy.example.com:8443/cb' }],
      ['a custom origin on the generated path', { redirect_uri: `https://proxy.example.com${CALLBACK}`, callback_port: 19876 }],
      ['a callback port set by hand', { callback_port: 19876 }],
      ['a loopback redirect for the user\'s own tunnel', { redirect_uri: 'http://127.0.0.1:19876/callback' }],
    ])('never touches %s', async (_label, oauth) => {
      const { app, config, opencode } = await build({ entry: remoteEntry(oauth) });
      await startFromRemote(app).expect(299);
      expect(config.updates).toEqual([]);
      expect(config.entry.oauth).toEqual(oauth);
      expect(opencode.starts).toBe(0);
    });

    it('moves a generated redirect to a new origin and keeps its port', async () => {
      const { app, config } = await build({
        entry: remoteEntry({ redirect_uri: `https://old.example.com${CALLBACK}`, callback_port: 45557 }),
      });
      writeAssignments({ 45557: { name: 'docs', redirectUri: `https://old.example.com${CALLBACK}` } });

      await startFromRemote(app).expect(200);

      expect(config.entry.oauth).toEqual({ redirect_uri: OWN_REDIRECT, callback_port: 45557 });
      const stored = JSON.parse(fs.readFileSync(storePath, 'utf8')).assignments;
      expect(stored[45557]).toEqual({ name: 'docs', redirectUri: OWN_REDIRECT });
    });

    it('writes nothing when the generated routing is already right', async () => {
      const { app, config, opencode } = await build({ entry: remoteEntry() });
      await startFromRemote(app).expect(200);
      await request(app).get(`${CALLBACK}?code=1&state=state-1`).expect(200);
      await new Promise((resolve) => opencode.listener.close(resolve));
      opencode.listener = null;

      await startFromRemote(app).expect(200);

      expect(config.updates).toHaveLength(1);
    });

    it('reassigns a generated port that another entry or process holds', async () => {
      const held = http.createServer();
      servers.push(held);
      const heldPort = await listen(held);
      const { app, config } = await build({
        entry: remoteEntry({ redirect_uri: OWN_REDIRECT, callback_port: heldPort }),
      });
      writeAssignments({ [heldPort]: { name: 'docs', redirectUri: OWN_REDIRECT } });

      await startFromRemote(app).expect(200);

      expect(config.entry.oauth.callback_port).not.toBe(heldPort);
      expect(Object.keys(JSON.parse(fs.readFileSync(storePath, 'utf8')).assignments)).toEqual([String(config.entry.oauth.callback_port)]);
    });

    it('recovers when a hand-copied entry shares the generated port', async () => {
      const { app, config } = await build({
        entry: remoteEntry({ redirect_uri: OWN_REDIRECT, callback_port: 45555 }),
        others: [{ name: 'other', type: 'remote', oauth: { callback_port: 45555 } }],
        signInOptions: { isPortFree: async () => true },
      });
      writeAssignments({ 45555: { name: 'docs', redirectUri: OWN_REDIRECT } });

      await startFromRemote(app).expect(200);

      expect(config.entry.oauth.callback_port).not.toBe(45555);
    });

    it('gives concurrent preparations different ports, also across projects', async () => {
      const taken = [];
      const allocate = async (takenPorts) => {
        const candidates = [41001, 41002];
        const port = candidates.find((candidate) => !takenPorts.has(candidate));
        await new Promise((resolve) => setImmediate(resolve));
        taken.push(port);
        return port;
      };
      const entries = new Map([
        ['/a', remoteEntry()],
        ['/b', { ...remoteEntry(), name: 'docs' }],
      ]);
      const app = express();
      app.use(express.json());
      const fakeOpenCode = http.createServer((req, res) => {
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET') return res.end(JSON.stringify({ data: { name: 'docs', metadata: { source: 'mcp' } } }));
        const directory = decodeURIComponent(req.headers['x-opencode-directory']);
        const authorization = new URL('https://provider.example.com/authorize');
        authorization.searchParams.set('redirect_uri', entries.get(directory).oauth.redirect_uri);
        authorization.searchParams.set('state', `state${directory}`);
        return res.end(JSON.stringify({ data: { attemptID: directory, url: authorization.toString() } }));
      });
      servers.push(fakeOpenCode);
      const port = await listen(fakeOpenCode);
      const signIn = createMcpOAuthSignIn({
        storePath,
        buildOpenCodeUrl: (target) => `http://127.0.0.1:${port}${target}`,
        getOpenCodeAuthHeaders: () => ({}),
        resolveProjectDirectory: async (req) => ({ directory: req.get('x-opencode-directory') }),
        getMcpConfig: (_name, directory) => entries.get(directory),
        listMcpConfigs: (directory) => [entries.get(directory)],
        updateMcpConfig: (_name, updates, directory) => {
          entries.set(directory, { ...entries.get(directory), ...updates });
        },
        allocatePort: allocate,
      });
      signIn.registerStartRoutes(app, { readBody: async () => undefined });

      // The second start for /a finds what the first one wrote.
      await Promise.all(['/a', '/a', '/b'].map((directory) => startFromRemote(app).set('x-opencode-directory', directory).expect(200)));

      expect(taken.toSorted()).toEqual([41001, 41002]);
    });

    it('starts again until OpenCode runs on the written redirect', async () => {
      const { app, opencode } = await build({ entry: remoteEntry() });
      opencode.staleStarts = 2;

      const response = await startFromRemote(app).expect(200);

      expect(response.body.data.attemptID).toBe('attempt-3');
      expect(opencode.cancelled).toEqual(['attempt-1', 'attempt-2']);
    });

    it('says so when OpenCode never picks the redirect up, and leaves no attempt', async () => {
      const { app, opencode } = await build({ entry: remoteEntry(), signInOptions: { configPickupTimeoutMs: 0 } });
      opencode.staleStarts = 5;

      const response = await startFromRemote(app).expect(503);

      expect(response.body.message).toMatch(/has not picked up/);
      expect(opencode.cancelled).toEqual(['attempt-1']);
      await request(app).get(`${CALLBACK}?code=1&state=state-1`).expect(400);
    });

    it('fails an unreadable assignment store instead of reading it as empty', async () => {
      fs.writeFileSync(storePath, '{ broken');
      const { app, config, opencode } = await build({ entry: remoteEntry() });

      await startFromRemote(app).expect(502);

      expect(config.updates).toEqual([]);
      expect(opencode.starts).toBe(0);
    });

    it('replaces the attempt of a second start for the same server', async () => {
      const { app, opencode } = await build({ entry: remoteEntry() });
      await startFromRemote(app).expect(200);
      await startFromRemote(app).expect(200);
      expect(opencode.cancelled).toEqual(['attempt-1']);
      await request(app).get(`${CALLBACK}?code=1&state=state-1`).expect(400);
      expect(opencode.listenerHits).toBe(0);
    });
  });

  describe('sign-ins finished by a pasted address', () => {
    const fromRelay = (app) => request(app)
      .post(START)
      .set('x-openchamber-relay-connection', 'connection-1')
      .send({});

    it('starts a relay-only sign-in on OpenCode\'s own redirect for the user to paste', async () => {
      const { app, config, opencode } = await build({ entry: remoteEntry() });
      opencode.paste = true;

      const response = await fromRelay(app).expect(200);

      expect(response.body.data).toMatchObject({ attemptID: 'attempt-1', paste: true });
      expect(config.updates).toEqual([]);
      expect(opencode.cancelled).toEqual([]);
      // Nothing was bound, so no browser can finish it through OpenChamber.
      await request(app).get(`${CALLBACK}?code=c&state=state-1`).expect(400);
      expect(opencode.listenerHits).toBe(0);
    });

    it('refuses a relay-only sign-in when OpenCode cannot take a pasted address', async () => {
      const { app, config, opencode } = await build({ entry: remoteEntry() });

      const response = await fromRelay(app).expect(400);

      expect(response.body).toMatchObject({ _tag: 'InvalidRequestError' });
      expect(response.body.message).toMatch(/private relay/);
      expect(config.updates).toEqual([]);
      expect(opencode.cancelled).toEqual(['attempt-1']);
    });

    it('lets a relay client use a redirect already generated for a direct address', async () => {
      const { app, opencode } = await build({ entry: remoteEntry({ redirect_uri: OWN_REDIRECT, callback_port: 45556 }) });
      writeAssignments({ 45556: { name: 'docs', redirectUri: OWN_REDIRECT } });

      await fromRelay(app).expect(200);
      await request(app).get(`${CALLBACK}?code=c&state=state-1`).expect(200);

      expect(opencode.completed).toHaveLength(1);
    });

    const fromPlainHttp = (app) => request(app).post(START).set('Host', '192.168.1.20:3000').send({});

    it('starts a sign-in to paste for a browser on another machine over plain http', async () => {
      const { app, config, opencode } = await build({ entry: remoteEntry() });
      opencode.paste = true;

      const response = await fromPlainHttp(app).expect(200);

      expect(response.body.data.paste).toBe(true);
      expect(new URL(response.body.data.url).searchParams.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(config.updates).toEqual([]);
    });

    it('generates an http redirect for a plain-http browser when OpenCode cannot take a pasted address', async () => {
      const { app, config, opencode } = await build({ entry: remoteEntry() });

      const response = await fromPlainHttp(app).expect(200);

      expect(opencode.cancelled).toEqual(['attempt-1']);
      expect(config.updates).toHaveLength(1);
      expect(new URL(response.body.data.url).searchParams.get('redirect_uri'))
        .toBe('http://192.168.1.20:3000/api/mcp/oauth/docs/callback');
    });

    it.each([
      ['a remote browser', (app) => startFromRemote(app)],
      ['a browser on loopback', (app) => request(app).post(START).set('Host', 'localhost:3000').send({})],
      ['a relay client', fromRelay],
    ])('starts a sign-in to paste for %s when OpenCode runs on another machine', async (_label, send) => {
      const { app, config, opencode } = await build({ entry: remoteEntry(), baseUrl: OFF_MACHINE_URL });
      opencode.paste = true;

      const response = await send(app).expect(200);

      expect(response.body.data.paste).toBe(true);
      expect(config.updates).toEqual([]);
    });

    it('refuses an off-machine sign-in when OpenCode cannot take a pasted address', async () => {
      const { app, config, opencode } = await build({ entry: remoteEntry(), baseUrl: OFF_MACHINE_URL });

      const response = await startFromRemote(app).expect(400);

      expect(response.body.message).toMatch(/another machine/);
      expect(config.updates).toEqual([]);
      expect(opencode.cancelled).toEqual(['attempt-1']);
    });

    it('leaves a generated redirect alone once OpenCode moved to another machine', async () => {
      const entry = remoteEntry({ redirect_uri: OWN_REDIRECT, callback_port: 45558 });
      const { app, config, opencode } = await build({ entry, baseUrl: OFF_MACHINE_URL });
      writeAssignments({ 45558: { name: 'docs', redirectUri: OWN_REDIRECT } });
      opencode.paste = true;

      await startFromRemote(app).expect(200);

      expect(config.updates).toEqual([]);
      await request(app).get(`${CALLBACK}?code=c&state=state-1`).expect(400);
      expect(opencode.listenerHits).toBe(0);
    });

    it('keeps a route a person configured for an off-machine OpenCode', async () => {
      const { app, opencode } = await build({
        entry: remoteEntry({ redirect_uri: 'https://opencode.example.com/cb' }),
        baseUrl: OFF_MACHINE_URL,
      });

      await startFromRemote(app).expect(299);

      expect(opencode.starts).toBe(0);
    });
  });

  describe('callback', () => {
    const started = async () => {
      const built = await build({ entry: remoteEntry() });
      await startFromRemote(built.app).expect(200);
      return built;
    };

    it('forwards the allowlisted query for a live attempt and relays the page', async () => {
      const { app, opencode } = await started();

      await request(app)
        .get(`${CALLBACK}?code=code-1&state=state-1&extra=drop`)
        .expect(200)
        .expect('content-type', /text\/html/);

      expect(opencode.completed).toEqual([`${CALLBACK}?code=code-1&state=state-1`]);
    });

    it('forwards a provider error that carries the attempt\'s state', async () => {
      const { app, opencode } = await started();
      await request(app).get(`${CALLBACK}?error=access_denied&state=state-1`).expect(200);
      expect(opencode.listenerHits).toBe(1);
    });

    it.each([
      ['a missing state', 'code=1'],
      ['a wrong state', 'code=1&state=guess'],
      ['an error with no state', 'error=access_denied'],
    ])('makes no loopback request for %s, and the real attempt still completes', async (_label, query) => {
      const { app, opencode } = await started();

      await request(app).get(`${CALLBACK}?${query}`).expect(400);

      expect(opencode.listenerHits).toBe(0);
      expect(opencode.failed).toBe(false);
      await request(app).get(`${CALLBACK}?code=code-1&state=state-1`).expect(200);
      expect(opencode.completed).toHaveLength(1);
    });

    it('refuses the valid state on another server\'s callback without using it up', async () => {
      const { app, opencode } = await started();
      await request(app).get('/api/mcp/oauth/other/callback?code=1&state=state-1').expect(400);
      expect(opencode.listenerHits).toBe(0);
      await request(app).get(`${CALLBACK}?code=1&state=state-1`).expect(200);
    });

    it('refuses a replayed callback', async () => {
      const { app, opencode } = await started();
      await request(app).get(`${CALLBACK}?code=1&state=state-1`).expect(200);
      await request(app).get(`${CALLBACK}?code=1&state=state-1`).expect(400);
      expect(opencode.listenerHits).toBe(1);
    });

    it('refuses an expired attempt', async () => {
      const { app, opencode } = await build({ entry: remoteEntry() });
      opencode.expires = Date.now() - 1;
      await startFromRemote(app).expect(200);
      await request(app).get(`${CALLBACK}?code=1&state=state-1`).expect(400);
      expect(opencode.listenerHits).toBe(0);
    });

    it('refuses a cancelled attempt', async () => {
      const { app, opencode } = await started();
      await request(app).delete(`${START}/attempt-1`).expect(299);
      await request(app).get(`${CALLBACK}?code=1&state=state-1`).expect(400);
      expect(opencode.listenerHits).toBe(0);
    });

    it('makes no loopback request with no attempt, whatever the config says', async () => {
      let hits = 0;
      const service = http.createServer((_req, res) => {
        hits += 1;
        res.end('private');
      });
      servers.push(service);
      const port = await listen(service);
      const { app } = await build({ entry: remoteEntry({ redirect_uri: OWN_REDIRECT, callback_port: port }) });

      const response = await request(app).get(`${CALLBACK}?code=1&state=2`).expect(400);

      expect(hits).toBe(0);
      expect(response.text).not.toContain('private');
    });

    it('completes after another client changed the project or the config', async () => {
      const { app, config, opencode } = await started();
      config.directory = '/elsewhere';
      config.entry = null;

      await request(app).get(`${CALLBACK}?code=1&state=state-1`).expect(200);

      expect(opencode.completed).toHaveLength(1);
    });

    it('does not follow a redirect from the listener', async () => {
      let followed = 0;
      const elsewhere = http.createServer((_req, res) => {
        followed += 1;
        res.end('secret');
      });
      servers.push(elsewhere);
      const elsewherePort = await listen(elsewhere);
      const { app, opencode } = await started();
      opencode.listenerRedirect = `http://127.0.0.1:${elsewherePort}/secret`;

      await request(app).get(`${CALLBACK}?code=1&state=state-1`).expect(302);

      expect(followed).toBe(0);
    });

    it('answers 502 when the listener is gone', async () => {
      const { app, opencode } = await started();
      await new Promise((resolve) => opencode.listener.close(resolve));
      opencode.listener = null;
      await request(app).get(`${CALLBACK}?code=1&state=state-1`).expect(502);
    });
  });
});
