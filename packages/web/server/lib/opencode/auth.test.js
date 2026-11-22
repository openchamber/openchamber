import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { configureOpenCodeCredentials, credentialSourceUsesLocalStore, getProviderAuth, getStoredLogin, listStoredCredentials, openCodeCredentialSource, openCodeLocalCredentialSource, projectCredentialEntries, projectCredentialRows, projectEnvironmentKeys, readLocalOpenCodeCredentials, readOpenCodeCredentials, renewStoredLogin } from './auth.js';
import { OpenCodeUpstreamAuthError, isOpenCodeUpstreamAuthRejection } from './credential-auth-error.js';

const entry = (integrationID, active, value) => ({ id: `cred_${integrationID}_${active}`, integrationID, label: 'default', active, value });

describe('projectCredentialEntries', () => {
  it('keeps each integration’s active credential in the legacy entry shape', () => {
    const projected = projectCredentialEntries([
      entry('zai-coding-plan', false, { type: 'key', key: 'old' }),
      entry('zai-coding-plan', true, { type: 'key', key: 'zai-key' }),
      entry('openai', true, {
        type: 'oauth',
        methodID: 'chatgpt-browser',
        access: 'at',
        refresh: 'rt',
        expires: 42,
        metadata: { accountID: 'acc_1' },
      }),
      entry('github-copilot', true, {
        type: 'oauth',
        methodID: 'device',
        access: 'gh',
        refresh: 'gh-r',
        expires: 0,
        metadata: { enterpriseUrl: 'https://ghe.example' },
      }),
      entry('custom', true, { type: 'key', key: 'k', metadata: { region: 'eu' } }),
    ]);

    expect(projected).toEqual({
      'zai-coding-plan': { type: 'api', key: 'zai-key' },
      openai: { type: 'oauth', access: 'at', refresh: 'rt', expires: 42, accountId: 'acc_1' },
      'github-copilot': { type: 'oauth', access: 'gh', refresh: 'gh-r', expires: 0, enterpriseUrl: 'https://ghe.example' },
      custom: { type: 'api', key: 'k', metadata: { region: 'eu' } },
    });
  });

  it('stores a __proto__ integration id as an enumerable own entry, not as the prototype', () => {
    const projected = projectCredentialEntries([
      entry('__proto__', true, { type: 'key', key: 'proto-key' }),
      entry('deepseek', true, { type: 'key', key: 'ds' }),
    ]);
    expect(Object.hasOwn(projected, '__proto__')).toBe(true);
    expect(Object.keys(projected)).toEqual(expect.arrayContaining(['__proto__', 'deepseek']));
    expect(projected['__proto__']).toEqual({ type: 'api', key: 'proto-key' });
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
  });

  it('keeps only the Console server and organization from OpenCode Console metadata', () => {
    const projected = projectCredentialEntries([
      entry('opencode', true, {
        type: 'oauth',
        methodID: 'console',
        access: 'console-access',
        refresh: 'console-refresh',
        expires: 42,
        metadata: {
          server: 'https://opencode.ai/console',
          orgID: 'org_TESTORG123',
          accountID: 'acc_console',
          email: 'person@example.com',
          orgName: 'Example',
        },
      }),
    ]);

    expect(projected).toEqual({
      opencode: {
        type: 'oauth',
        access: 'console-access',
        refresh: 'console-refresh',
        expires: 42,
        accountId: 'acc_console',
        server: 'https://opencode.ai/console',
        orgID: 'org_TESTORG123',
      },
    });
  });
});

describe('projectCredentialRows', () => {
  it('keeps every row with its id, label and active flag in the legacy entry shape', () => {
    const rows = projectCredentialRows([
      entry('openai', false, { type: 'oauth', methodID: 'chatgpt-browser', access: 'legacy', refresh: 'rt', expires: 42, metadata: { accountID: 'acc_1' } }),
      entry('openai', true, { type: 'oauth', methodID: 'chatgpt-token-sharing', access: 'sharing', refresh: 'rt2', expires: 43, metadata: {} }),
      { id: 'cred_x', integrationID: 'deepseek', label: '', active: true, value: { type: 'key', key: 'ds' } },
    ]);

    expect(rows).toEqual([
      { id: 'cred_openai_false', integrationID: 'openai', label: 'default', active: false, value: { type: 'oauth', access: 'legacy', refresh: 'rt', expires: 42, accountId: 'acc_1' } },
      { id: 'cred_openai_true', integrationID: 'openai', label: 'default', active: true, value: { type: 'oauth', access: 'sharing', refresh: 'rt2', expires: 43 } },
      { id: 'cred_x', integrationID: 'deepseek', label: null, active: true, value: { type: 'api', key: 'ds' } },
    ]);
  });
});

describe('projectEnvironmentKeys', () => {
  it('takes each variable OpenCode reports from the launch environment', () => {
    const integrations = [
      { id: 'zai-coding-plan', connections: [{ type: 'env', name: 'ZHIPU_API_KEY' }] },
      { id: 'deepseek', connections: [{ type: 'credential', id: 'c', label: 'default', method: 'key' }] },
      { id: 'openrouter', connections: [{ type: 'env', name: 'OPENROUTER_API_KEY' }] },
      { id: 'blank', connections: [{ type: 'env', name: 'BLANK_KEY' }] },
    ];
    expect(projectEnvironmentKeys(integrations, { ZHIPU_API_KEY: ' zk ', BLANK_KEY: '  ' })).toEqual({ 'zai-coding-plan': 'zk' });
  });
});

describe('readOpenCodeCredentials', () => {
  let server;
  let requests;
  let respond;
  let integrations;
  let launchEnvironment;
  let directoryHeaders;

  beforeEach(async () => {
    requests = [];
    directoryHeaders = [];
    integrations = [];
    launchEnvironment = null;
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [entry('deepseek', true, { type: 'key', key: 'ds' })] }));
    };
    server = http.createServer((req, res) => {
      requests.push({ url: req.url, authorization: req.headers.authorization });
      directoryHeaders.push([req.url, req.headers['x-opencode-directory'] ?? null]);
      if (req.url.startsWith('/api/integration')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: integrations }));
        return;
      }
      respond(res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    configureOpenCodeCredentials(openCodeCredentialSource({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:${port}${path}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
      getLaunchEnvironment: () => launchEnvironment,
      getDefaultDirectory: () => '/work/last project',
    }));
  });

  afterEach(async () => {
    configureOpenCodeCredentials(null);
    await new Promise((resolve) => server.close(resolve));
  });

  it('asks the running OpenCode with its auth headers', async () => {
    await expect(readOpenCodeCredentials()).resolves.toEqual({ deepseek: { type: 'api', key: 'ds' } });
    await expect(getProviderAuth('deepseek')).resolves.toEqual({ type: 'api', key: 'ds' });
    await expect(getProviderAuth('openai')).resolves.toBeNull();
    expect(requests[0]).toEqual({ url: '/api/credential', authorization: 'Basic test' });
  });

  it('does not resolve prototype-name provider ids as stored auth', async () => {
    for (const providerId of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      await expect(getProviderAuth(providerId)).resolves.toBeNull();
    }
    await expect(getProviderAuth('deepseek')).resolves.toEqual({ type: 'api', key: 'ds' });
  });

  it('resolves a genuinely stored __proto__ credential', async () => {
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [entry('__proto__', true, { type: 'key', key: 'proto-key' })] }));
    };
    await expect(getProviderAuth('__proto__')).resolves.toEqual({ type: 'api', key: 'proto-key' });
  });

  it('lists every stored credential row, not only the active one', async () => {
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        data: [
          entry('openai', false, { type: 'oauth', methodID: 'chatgpt-browser', access: 'legacy', refresh: 'rt-legacy', expires: 42, metadata: { accountID: 'acc_1' } }),
          entry('openai', true, { type: 'oauth', methodID: 'chatgpt-token-sharing', access: 'sharing', refresh: 'rt-sharing', expires: 43, metadata: {} }),
          entry('deepseek', true, { type: 'key', key: 'ds' }),
        ],
      }));
    };

    const openaiRows = await listStoredCredentials('openai');
    expect(openaiRows.map((row) => [row.label, row.active, row.value.access])).toEqual([
      ['default', false, 'legacy'],
      ['default', true, 'sharing'],
    ]);
    expect(openaiRows[0].value.accountId).toBe('acc_1');
    await expect(listStoredCredentials()).resolves.toHaveLength(3);
    await expect(listStoredCredentials('anthropic')).resolves.toEqual([]);
  });

  it('reads the selected browser login of an integration with its method and metadata, and without the refresh token', async () => {
    const oauth = { type: 'oauth', methodID: 'chatgpt-token-sharing', access: 'eyJ-short', refresh: 'rt-long', expires: 1791600000000, metadata: { clientID: 'client_1' } };
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [entry('openai', false, { ...oauth, methodID: 'chatgpt-browser' }), entry('openai', true, oauth), entry('deepseek', true, { type: 'key', key: 'ds' })] }));
    };
    await expect(getStoredLogin('openai')).resolves.toEqual({ methodID: 'chatgpt-token-sharing', access: 'eyJ-short', expires: 1791600000000, metadata: { clientID: 'client_1' } });
    await expect(getStoredLogin('deepseek')).resolves.toBeNull();
    await expect(getStoredLogin('anthropic')).resolves.toBeNull();
    respond = (res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [entry('openai', true, { ...oauth, metadata: undefined })] }));
    };
    await expect(getStoredLogin('openai')).resolves.toMatchObject({ metadata: {} });
  });

  it('adds variable keys of a managed OpenCode, with stored credentials winning', async () => {
    integrations = [
      { id: 'deepseek', connections: [{ type: 'env', name: 'DEEPSEEK_API_KEY' }] },
      { id: 'zai-coding-plan', connections: [{ type: 'env', name: 'ZHIPU_API_KEY' }] },
    ];
    launchEnvironment = { DEEPSEEK_API_KEY: 'ds-env', ZHIPU_API_KEY: 'zk-env' };
    await expect(readOpenCodeCredentials()).resolves.toEqual({
      deepseek: { type: 'api', key: 'ds' },
      'zai-coding-plan': { type: 'api', key: 'zk-env' },
    });
    // A variable is not a stored login.
    await expect(getProviderAuth('zai-coding-plan')).resolves.toBeNull();
    // Integrations are read through a location: without a directory OpenCode
    // would start its working directory, MCP servers included.
    expect(directoryHeaders.find(([url]) => url.startsWith('/api/integration'))?.[1])
      .toBe(encodeURIComponent('/work/last project'));
  });

  it('leaves variable keys out for an external OpenCode', async () => {
    integrations = [{ id: 'zai-coding-plan', connections: [{ type: 'env', name: 'ZHIPU_API_KEY' }] }];
    await expect(readOpenCodeCredentials()).resolves.toEqual({ deepseek: { type: 'api', key: 'ds' } });
    expect(requests.map((request) => request.url)).toEqual(['/api/credential']);
  });

  it('shares one request between concurrent callers', async () => {
    const [first, second] = await Promise.all([readOpenCodeCredentials(), readOpenCodeCredentials()]);
    expect(first).toBe(second);
    expect(requests).toHaveLength(1);
  });

  it('throws instead of answering empty when OpenCode fails', async () => {
    respond = (res) => {
      res.statusCode = 500;
      res.end('{}');
    };
    await expect(readOpenCodeCredentials()).rejects.toThrow();
  });

  it('throws before OpenCode is wired', async () => {
    configureOpenCodeCredentials(null);
    await expect(readOpenCodeCredentials()).rejects.toThrow('OpenCode is not connected yet');
  });
});

describe('renewStoredLogin', () => {
  const stored = (entries) => entries.map((entry) => ({ ...entry }));
  const oauth = { type: 'oauth', methodID: 'chatgpt-token-sharing', access: 'at-old', refresh: 'rt-old', expires: 1791600000000, metadata: { clientID: 'client_1', scopes: ['chatgpt.tokens.use.direct'] } };
  let server;
  let rows;
  let requests;
  let created = 0;
  let failCreate = false;

  beforeEach(async () => {
    requests = [];
    rows = stored([{ id: 'cred_openai_old', integrationID: 'openai', label: 'My ChatGPT', active: true, value: oauth }, entry('deepseek', true, { type: 'key', key: 'ds' })]);
    created = 0;
    failCreate = false;
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
        res.setHeader('content-type', 'application/json');
        if (req.method === 'GET' && req.url === '/api/credential') return res.end(JSON.stringify({ data: rows }));
        if (req.method === 'POST' && req.url === '/api/credential') {
          if (failCreate) { res.statusCode = 500; return res.end(JSON.stringify({ name: 'UnknownError', data: { message: 'no' } })); }
          const input = JSON.parse(body);
          const row = { id: input.id ?? `cred_made_${(created += 1)}`, integrationID: input.integrationID, label: input.label ?? 'default', active: input.activate !== false, value: input.value };
          for (const other of rows) if (other.integrationID === row.integrationID && row.active) other.active = false;
          rows.push(row);
          return res.end(JSON.stringify({ data: row }));
        }
        const removal = req.method === 'DELETE' && /^\/api\/credential\/([^/]+)$/.exec(req.url);
        if (removal) {
          rows = rows.filter((row) => row.id !== removal[1]);
          res.statusCode = 204;
          return res.end();
        }
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    configureOpenCodeCredentials(openCodeCredentialSource({ buildOpenCodeUrl: (path) => `http://127.0.0.1:${port}${path}`, getOpenCodeAuthHeaders: () => ({}) }));
  });

  afterEach(async () => {
    configureOpenCodeCredentials(null);
    await new Promise((resolve) => server.close(resolve));
  });

  it('hands the refresh token to the exchange, writes the new login first and removes the old row after it, and answers without the refresh token', async () => {
    const given = [];
    const answer = await renewStoredLogin('openai', async (login) => { given.push(login); return { access: 'at-new', refresh: 'rt-new', expires: 1791603600000, metadata: { clientID: 'client_1', scopes: ['chatgpt.tokens.use.direct'] } }; });
    expect(given).toEqual([{ methodID: 'chatgpt-token-sharing', refresh: 'rt-old', metadata: oauth.metadata }]);
    expect(answer).toEqual({ methodID: 'chatgpt-token-sharing', access: 'at-new', expires: 1791603600000, metadata: oauth.metadata });
    expect(requests.map(({ method, url }) => `${method} ${url}`)).toEqual(['GET /api/credential', 'GET /api/credential', 'POST /api/credential', 'DELETE /api/credential/cred_openai_old']);
    expect(requests[2].body).toEqual({ integrationID: 'openai', label: 'My ChatGPT', activate: true, value: { ...oauth, access: 'at-new', refresh: 'rt-new', expires: 1791603600000 } });
    expect(rows).toEqual([expect.objectContaining({ integrationID: 'deepseek' }), { id: 'cred_made_1', integrationID: 'openai', label: 'My ChatGPT', active: true, value: { ...oauth, access: 'at-new', refresh: 'rt-new', expires: 1791603600000 } }]);
    await expect(getStoredLogin('openai')).resolves.toEqual(answer);
  });

  it('answers null without an exchange when the host has no such login', async () => {
    const exchanges = [];
    await expect(renewStoredLogin('anthropic', async (login) => { exchanges.push(login); })).resolves.toBeNull();
    await expect(renewStoredLogin('deepseek', async (login) => { exchanges.push(login); })).resolves.toBeNull();
    expect(exchanges).toEqual([]);
    expect(requests.filter(({ method }) => method !== 'GET')).toEqual([]);
  });

  it('drops its tokens and answers the login OpenCode holds when the row changed during the exchange', async () => {
    const answer = await renewStoredLogin('openai', async () => {
      // OpenCode refreshed on its own meanwhile, as it does when the user prompts it.
      rows[0] = { ...rows[0], value: { ...oauth, access: 'at-by-opencode', refresh: 'rt-by-opencode', expires: 1791607200000 } };
      return { access: 'at-new', refresh: 'rt-new', expires: 1791603600000 };
    });
    expect(answer).toEqual({ methodID: 'chatgpt-token-sharing', access: 'at-by-opencode', expires: 1791607200000, metadata: oauth.metadata });
    expect(requests.filter(({ method }) => method !== 'GET')).toEqual([]);
    const signedOut = await renewStoredLogin('openai', async () => { rows = rows.filter((row) => row.integrationID !== 'openai'); return { access: 'at-new', refresh: 'rt-new', expires: 1 }; });
    expect(signedOut).toBeNull();
    expect(rows.find((row) => row.integrationID === 'openai')).toBeUndefined();
  });

  it('leaves the old row when the exchange or the write fails', async () => {
    await expect(renewStoredLogin('openai', async () => { throw new Error('issuer answered 401'); })).rejects.toThrow('issuer answered 401');
    failCreate = true;
    await expect(renewStoredLogin('openai', async () => ({ access: 'at-new', refresh: 'rt-new', expires: 1 }))).rejects.toThrow();
    expect(rows[0]).toEqual(expect.objectContaining({ id: 'cred_openai_old', active: true, value: oauth }));
    expect(requests.filter(({ method }) => method === 'DELETE')).toEqual([]);
  });

  it('refuses before OpenCode is wired and on a connection that cannot write', async () => {
    configureOpenCodeCredentials(null);
    await expect(renewStoredLogin('openai', async () => ({}))).rejects.toThrow('not connected');
    configureOpenCodeCredentials({ list: async () => rows });
    await expect(renewStoredLogin('openai', async () => ({}))).rejects.toThrow('cannot write');
  });
});

describe('shared upstream-auth provenance (#1129)', () => {
  afterEach(() => {
    configureOpenCodeCredentials(null);
  });

  it('marks a 401 rejection from the credential source as the shared credential path', async () => {
    configureOpenCodeCredentials({
      list: async () => {
        throw Object.assign(new Error('Authentication required'), { status: 401 });
      },
    });

    const error = await readOpenCodeCredentials().catch((thrown) => thrown);
    expect(error).toBeInstanceOf(OpenCodeUpstreamAuthError);
    expect(isOpenCodeUpstreamAuthRejection(error)).toBe(true);
    expect(error.origin).toBe('opencode-credential-source');
    expect(error.message).toBe('Authentication required');
  });

  it('marks the bare 401 body when the client error carries no status', async () => {
    configureOpenCodeCredentials({
      list: async () => {
        throw new Error('  Authentication required  ');
      },
    });

    const error = await readOpenCodeCredentials().catch((thrown) => thrown);
    expect(isOpenCodeUpstreamAuthRejection(error)).toBe(true);
  });

  it('leaves a credential-source failure that is not an auth rejection unmarked', async () => {
    configureOpenCodeCredentials({
      list: async () => {
        throw Object.assign(new Error('OpenCode is unreachable'), { status: 503 });
      },
    });

    const error = await readOpenCodeCredentials().catch((thrown) => thrown);
    expect(isOpenCodeUpstreamAuthRejection(error)).toBe(false);
    expect(error.message).toBe('OpenCode is unreachable');
  });

  it('does not treat a provider-worded failure as a shared-path rejection', async () => {
    configureOpenCodeCredentials({
      list: async () => {
        throw Object.assign(new Error('Authentication required'), { status: 403 });
      },
    });

    const error = await readOpenCodeCredentials().catch((thrown) => thrown);
    expect(isOpenCodeUpstreamAuthRejection(error)).toBe(false);
  });

  it('marks an auth rejection from the environment-key read when it arrives first', async () => {
    configureOpenCodeCredentials({
      list: async () => [],
      listEnvironmentKeys: async () => {
        throw Object.assign(new Error('Authentication required'), { status: 401 });
      },
    });

    const error = await readOpenCodeCredentials().catch((thrown) => thrown);
    expect(error).toBeInstanceOf(OpenCodeUpstreamAuthError);
    expect(isOpenCodeUpstreamAuthRejection(error)).toBe(true);
    expect(error.message).toBe('Authentication required');
  });

  it('marks the credential-row read the same way', async () => {
    configureOpenCodeCredentials({
      list: async () => {
        throw Object.assign(new Error('Authentication required'), { status: 401 });
      },
    });

    const error = await listStoredCredentials().catch((thrown) => thrown);
    expect(isOpenCodeUpstreamAuthRejection(error)).toBe(true);
  });
});

describe('credentialSourceUsesLocalStore', () => {
  afterEach(() => {
    configureOpenCodeCredentials(null);
  });

  it('is false when no source is wired or the source does not say', () => {
    configureOpenCodeCredentials(null);
    expect(credentialSourceUsesLocalStore()).toBe(false);
    configureOpenCodeCredentials({ list: async () => [] });
    expect(credentialSourceUsesLocalStore()).toBe(false);
  });

  it('follows the wired source declaration', () => {
    configureOpenCodeCredentials({ list: async () => [], usesLocalStore: () => true });
    expect(credentialSourceUsesLocalStore()).toBe(true);
    configureOpenCodeCredentials({ list: async () => [], usesLocalStore: () => false });
    expect(credentialSourceUsesLocalStore()).toBe(false);
  });

  it('treats a managed or loopback connection as local and a remote host as not', () => {
    const sourceFor = (url, launchEnvironment = null) => openCodeCredentialSource({
      buildOpenCodeUrl: () => url,
      getOpenCodeAuthHeaders: () => ({}),
      getLaunchEnvironment: () => launchEnvironment,
    });
    expect(sourceFor('http://127.0.0.1:4096').usesLocalStore()).toBe(true);
    expect(sourceFor('http://127.0.0.2:4096').usesLocalStore()).toBe(true);
    expect(sourceFor('http://foo.localhost:4096').usesLocalStore()).toBe(true);
    expect(sourceFor('http://[::ffff:127.0.0.1]:4096').usesLocalStore()).toBe(true);
    expect(sourceFor('http://localhost.evil.example:4096').usesLocalStore()).toBe(false);
    expect(sourceFor('https://opencode.example.com:4096').usesLocalStore()).toBe(false);
    expect(sourceFor('https://opencode.example.com:4096', { OPENCODE_DB: 'opencode.db' }).usesLocalStore()).toBe(true);
  });
});

describe('readLocalOpenCodeCredentials', () => {
  let root;
  let savedXdg;
  let savedDb;

  const createStoreAt = (dbPath, key) => {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(`create table credential (
      id text primary key,
      integration_id text,
      label text not null,
      value text not null,
      connector_id text,
      method_id text,
      active integer,
      time_created integer not null,
      time_updated integer not null
    )`);
    db.prepare('insert into credential (id, integration_id, label, value, active, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?)')
      .run('cred_google', 'google', 'default', JSON.stringify({ type: 'key', key }), 1, 100, 100);
    db.close();
  };

  const storeEnv = (dataHome) => ({ XDG_DATA_HOME: dataHome, HOME: root });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-auth-local-test-'));
    savedXdg = process.env.XDG_DATA_HOME;
    savedDb = process.env.OPENCODE_DB;
    delete process.env.OPENCODE_DB;
  });

  afterEach(() => {
    configureOpenCodeCredentials(null);
    if (savedXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = savedXdg;
    if (savedDb === undefined) delete process.env.OPENCODE_DB; else process.env.OPENCODE_DB = savedDb;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('resolves the store from the launch environment, not process.env', async () => {
    const launchData = path.join(root, 'launch-data');
    const processData = path.join(root, 'process-data');
    createStoreAt(path.join(launchData, 'opencode', 'opencode.db'), 'launch-key');
    createStoreAt(path.join(processData, 'opencode', 'opencode.db'), 'process-key');
    process.env.XDG_DATA_HOME = processData;
    configureOpenCodeCredentials(openCodeCredentialSource({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      getLaunchEnvironment: () => storeEnv(launchData),
    }));
    await expect(readLocalOpenCodeCredentials()).resolves.toEqual({
      google: { type: 'api', key: 'launch-key' },
    });
  });

  it('refuses when the connected OpenCode has no launch environment', async () => {
    configureOpenCodeCredentials(openCodeCredentialSource({
      buildOpenCodeUrl: () => 'http://127.0.0.1:4096',
      getOpenCodeAuthHeaders: () => ({}),
      getLaunchEnvironment: () => null,
    }));
    await expect(readLocalOpenCodeCredentials()).rejects.toThrow('location is unknown');
  });
});

describe('openCodeLocalCredentialSource', () => {
  let dir;
  let dbPath;

  const createStore = (rows) => {
    const db = new DatabaseSync(dbPath);
    db.exec(`create table credential (
      id text primary key,
      integration_id text,
      label text not null,
      value text not null,
      connector_id text,
      method_id text,
      active integer,
      time_created integer not null,
      time_updated integer not null
    )`);
    const insert = db.prepare('insert into credential (id, integration_id, label, value, active, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?)');
    for (const row of rows) {
      insert.run(row.id, row.integration, row.label ?? 'default', row.value, row.active ?? null, row.created, row.created);
    }
    db.close();
  };

  const keyRow = (id, integration, key, extra = {}) => ({
    id,
    integration,
    value: JSON.stringify({ type: 'key', key }),
    created: 100,
    ...extra,
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-auth-test-'));
    dbPath = path.join(dir, 'opencode.db');
  });

  afterEach(() => {
    configureOpenCodeCredentials(null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('marks the newest legacy row active when no row carries the flag', async () => {
    createStore([
      keyRow('cred_a', 'deepseek', 'old-key', { created: 100 }),
      keyRow('cred_b', 'deepseek', 'new-key', { created: 200 }),
    ]);
    const entries = await openCodeLocalCredentialSource({ dbPath }).list();
    expect(entries).toEqual([
      { id: 'cred_a', integrationID: 'deepseek', label: 'default', active: false, value: { type: 'key', key: 'old-key' } },
      { id: 'cred_b', integrationID: 'deepseek', label: 'default', active: true, value: { type: 'key', key: 'new-key' } },
    ]);
  });

  it('honors an explicit active flag over creation order', async () => {
    createStore([
      keyRow('cred_a', 'deepseek', 'pinned-key', { created: 100, active: 1 }),
      keyRow('cred_b', 'deepseek', 'newer-key', { created: 200, active: 0 }),
    ]);
    const entries = await openCodeLocalCredentialSource({ dbPath }).list();
    expect(entries.find((entry) => entry.id === 'cred_a')?.active).toBe(true);
    expect(entries.find((entry) => entry.id === 'cred_b')?.active).toBe(false);
  });

  it('projects through the shared readers, skipping unreadable rows', async () => {
    createStore([
      keyRow('cred_a', 'deepseek', 'live-key', { created: 100 }),
      { id: 'cred_broken', integration: 'wafer', value: 'not json', created: 100 },
      { id: 'cred_orphan', integration: null, value: JSON.stringify({ type: 'key', key: 'x' }), created: 100 },
    ]);
    configureOpenCodeCredentials(openCodeLocalCredentialSource({ dbPath }));
    await expect(readOpenCodeCredentials()).resolves.toEqual({
      deepseek: { type: 'api', key: 'live-key' },
    });
    const rows = await listStoredCredentials();
    expect(rows.map((row) => row.id)).toEqual(['cred_a']);
  });

  it('fails clearly when the store file is missing', async () => {
    await expect(openCodeLocalCredentialSource({ dbPath }).list()).rejects.toThrow('not found');
  });

  it('fails rather than answering empty when every stored row is unreadable', async () => {
    createStore([{ id: 'cred_broken', integration: 'wafer', value: 'not json', created: 100 }]);
    await expect(openCodeLocalCredentialSource({ dbPath }).list()).rejects.toThrow('none could be read');
  });
});
