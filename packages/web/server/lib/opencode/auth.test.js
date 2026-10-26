import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';

import { configureOpenCodeCredentials, getProviderAuth, getStoredLogin, openCodeCredentialSource, projectCredentialEntries, projectEnvironmentKeys, readOpenCodeCredentials, renewStoredLogin } from './auth.js';

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
