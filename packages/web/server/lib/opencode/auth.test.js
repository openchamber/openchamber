import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';

import { configureOpenCodeCredentials, getProviderAuth, openCodeCredentialSource, projectCredentialEntries, projectEnvironmentKeys, readOpenCodeCredentials } from './auth.js';

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
