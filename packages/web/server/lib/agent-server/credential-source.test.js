import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureOpenCodeCredentials, getProviderAuth, getStoredLogin, renewStoredLogin, openCodeCredentialSource } from '../opencode/auth.js';
import { registerOpenCodeRoutes } from '../opencode/routes.js';
import { registerHostCredentialRoutes } from './host-credential-routes.js';
import { registerOpenCodeProxy } from '../opencode/proxy.js';
import { createAgentUpstream } from './agent-upstream.js';
import { createAgentCredentialSource } from './credential-source.js';

const cleanups = [];
afterEach(async () => {
  configureOpenCodeCredentials(null);
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const login = (provider = 'openai', value = {}) => ({ id: `cred_${provider}`, label: 'default', integrationID: provider, active: true,
  value: { type: 'oauth', methodID: provider === 'openai' ? 'chatgpt-browser' : 'device', access: 'agent-access', refresh: 'agent-refresh', expires: 100,
    metadata: provider === 'openai' ? { accountID: 'agent-account' } : { apiEndpoint: 'https://api.githubcopilot.com' }, ...value } });
const listen = async (app) => {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
};
const setup = async (initial = [login()]) => {
  let rows = initial;
  const writes = [];
  const opencode = express();
  opencode.use(express.json());
  opencode.use((req, res, next) => req.headers.authorization === 'Bearer agent-opencode' ? next() : res.sendStatus(401));
  opencode.get('/api/credential', (_req, res) => res.json({ data: rows }));
  opencode.post('/api/credential', (req, res) => {
    writes.push(req.body);
    const created = { id: 'cred_replacement', label: req.body.label, integrationID: req.body.integrationID, active: req.body.activate, value: req.body.value };
    rows = [...rows.map((row) => ({ ...row, active: false })), created];
    res.json({ data: created });
  });
  opencode.delete('/api/credential/:id', (req, res) => {
    rows = rows.filter((row) => row.id !== req.params.id);
    res.status(204).end();
  });
  const opencodePort = await listen(opencode);
  const agent = express();
  agent.use(express.json());
  agent.post('/auth/session', (_req, res) => res.set('Set-Cookie', 'oc_ui_session=agent; Max-Age=3600').json({}));
  agent.use((req, res, next) => req.headers.cookie === 'oc_ui_session=agent' ? next() : res.sendStatus(401));
  registerOpenCodeRoutes(agent, {});
  registerHostCredentialRoutes(agent, { agentServer: true, listProjectDirectories: async () => [],
    credentialSource: openCodeCredentialSource({ buildOpenCodeUrl: () => `http://127.0.0.1:${opencodePort}`, getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer agent-opencode' }) }),
  });
  registerOpenCodeProxy(agent, {
    fs: {}, os: {}, path, OPEN_CODE_READY_GRACE_MS: 0,
    getRuntime: () => ({ openCodePort: opencodePort, isOpenCodeReady: true, openCodeNotReadySince: 0, isRestartingOpenCode: false }),
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer agent-opencode' }),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:${opencodePort}${route}`, ensureOpenCodeApiPrefix() {},
  });
  const port = await listen(agent);
  const upstream = createAgentUpstream({ url: `http://127.0.0.1:${port}`, token: 'synthetic' });
  cleanups.push(() => upstream.close());
  const source = createAgentCredentialSource(upstream);
  configureOpenCodeCredentials(source);
  return { source, writes };
};

describe('front-door OpenCode credentials through the agent proxy', () => {
  it('reads stored keys through both authentication boundaries', async () => {
    // Given an agent-only OpenCode key.
    await setup([{ id: 'cred_gateway', label: 'default', integrationID: 'gateway', active: true, value: { type: 'key', key: 'agent-stored-key' } }]);
    // When the normal host credential helper runs. Then it reads the agent store.
    expect(await getProviderAuth('gateway')).toEqual({ type: 'api', key: 'agent-stored-key' });
  });
  it.each(['openai', 'github-copilot'])('reads the selected %s browser login through the agent', async (provider) => {
    // Given an agent-selected login. When the normal host reader runs. Then its token and method survive the boundary.
    await setup([login(provider)]);
    expect(await getStoredLogin(provider)).toEqual({ methodID: login(provider).value.methodID, access: 'agent-access', expires: 100, metadata: login(provider).value.metadata });
  });
  it.each(['', '1'])('renews and replaces an existing login with enterprise mode=%s', async (mode) => {
    // Given the real agent proxy and the host renewal helper.
    const { writes, source } = await setup();
    vi.stubEnv('OPENCHAMBER_ENTERPRISE_MODE', mode);
    // When the issuer exchange returns synthetic replacement tokens.
    const renewed = await renewStoredLogin('openai', async (input) => {
      expect(input.refresh).toBe('agent-refresh');
      return { access: 'renewed-access', refresh: 'renewed-refresh', expires: 999, metadata: input.metadata };
    });
    // Then the new active row is stored remotely and the prior row is gone.
    expect(renewed.access).toBe('renewed-access');
    expect(writes).toHaveLength(1);
    expect((await source.list()).map((row) => row.id)).toEqual(['cred_replacement']);
  });
  it.each([true, false])('reads an OAuth login beside an unrelated external credential with active=%s', async (active) => {
    // Given OpenCode's supported external credential beside a ChatGPT login.
    await setup([login(), { id: 'cred_external', integrationID: 'external-provider', label: 'External', active,
      value: { type: 'external', methodID: 'plugin-method', metadata: { region: 'test' } } }]);
    // When the host reads the ChatGPT login. Then the unrelated credential cannot block it.
    expect(await getStoredLogin('openai')).toMatchObject({ methodID: 'chatgpt-browser', access: 'agent-access' });
  });
  it.each([[{ ...login(), value: { type: 'oauth', access: 'bad' } }], [{ ...login(), value: { ...login().value, access: 's'.repeat(8193) } }]])('rejects malformed credential rows', async (row) => {
    // Given a hostile row. When the host reader runs. Then no untyped token is accepted.
    await setup([row]);
    await expect(getStoredLogin('openai')).rejects.toMatchObject({ code: 'agent_host_credential_unavailable' });
  });
  it('rejects a malformed successful reply from an untrusted agent', async () => {
    // Given an agent that bypasses its own route parser. When the front door reads it. Then its independent parser refuses it.
    const source = createAgentCredentialSource({ origin: 'http://localhost:1', fetch: async () => Response.json({ data: [{ ...login(), active: 'yes' }] }) });
    await expect(source.list()).rejects.toMatchObject({ code: 'agent_host_credential_invalid_response' });
  });
  it('drops extra agent authority fields from parsed credentials', async () => {
    // Given a valid row carrying extra claims. When parsed. Then only credential fields remain.
    const { source } = await setup([{ ...login(), spaceId: 'forged' }]);
    expect(await source.list()).toEqual([login()]);
  });
  it('returns a stable failure when the agent is unreachable', async () => {
    // Given a failed authenticated transport. When reading. Then no local credential source is consulted.
    const source = createAgentCredentialSource({ origin: 'http://localhost:1', fetch: async () => { throw new Error('synthetic failure'); } });
    await expect(source.list()).rejects.toMatchObject({ code: 'agent_host_credential_unavailable' });
  });
});
