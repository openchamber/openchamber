import express from 'express';
import request from 'supertest';
import http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { registerHostCredentialRoutes } from './host-credential-routes.js';
import { createAgentHostCredentials } from './host-credentials.js';
import { createAgentUpstream } from './agent-upstream.js';
import { HOST_CREDENTIAL_ROUTE as ROUTE, MAX_HOST_CREDENTIAL_BYTES } from './host-credential-contract.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const definition = { package: 'aisdk:@ai-sdk/openai-compatible', name: 'Agent gateway',
  settings: { baseURL: 'http://localhost:9999/v1' }, env: ['MODEL_KEY'], models: { small: { modelID: 'small' } } };
const setup = (options = {}) => {
  const app = express();
  app.use((req, res, next) => req.headers.authorization === 'Bearer synthetic' ? next() : res.sendStatus(401));
  registerHostCredentialRoutes(app, { agentServer: true, listProjectDirectories: async () => ['/agent/project'],
    environment: { MODEL_KEY: 'agent-key', OPENCHAMBER_UI_PASSWORD: 'internal' }, readStoredKey: async () => null,
    readLayers: () => ({ userConfig: { providers: { gateway: definition } } }), ...options });
  return app;
};
const get = (app, suffix) => request(app).get(`${ROUTE}/${suffix}`).set('authorization', 'Bearer synthetic');
const upstreamReply = (value, statusCode = 200) => ({ request: async () => Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), { statusCode, complete: true }) });

describe('agent host credential routes', () => {
  it('requires API authentication before reading a key', async () => {
    // Given a reachable credential route behind the API gate.
    const app = setup();
    expect((await get(app, 'secret?name=MODEL_KEY')).body).toEqual({ value: 'agent-key' });
    // When unauthenticated. Then no secret is returned.
    const response = await request(app).get(`${ROUTE}/secret?name=MODEL_KEY`);
    expect(response.status).toBe(401);
  });
  it('registers no credential route outside agent mode', async () => {
    // Given a route that is reachable in agent mode.
    expect((await get(setup(), 'secret?name=MODEL_KEY')).status).toBe(200);
    // When the same route is requested in ordinary mode. Then it is absent.
    expect((await get(setup({ agentServer: false }), 'secret?name=MODEL_KEY')).status).toBe(404);
  });
  it('lists definitions without keys and reads the selected provider with its agent key', async () => {
    // Given agent config and environment. When discovery and the selected read run. Then they preserve the host contract.
    const app = setup();
    const listed = await get(app, 'providers?directory=/agent/project');
    expect(listed.body).toEqual([{ id: 'gateway', name: 'Agent gateway', package: definition.package,
      baseURL: definition.settings.baseURL, models: ['small'], hasKey: true, loopback: true, supported: true }]);
    const selected = await get(app, 'provider?directory=/agent/project&provider=gateway');
    expect(selected.body).toMatchObject({ id: 'gateway', key: 'agent-key', models: definition.models });
    expect(selected.headers['cache-control']).toBe('no-store');
  });
  it.each(['relative', '/agent/other', '/agent/project/../other'])('refuses unregistered directory %s', async (directory) => {
    // Given the project registry. When another path is named. Then no project config is read.
    const response = await get(setup({ readLayers: () => { throw new Error('must not read'); } }), `providers?${new URLSearchParams({ directory })}`);
    expect(response.status).toBe(directory === 'relative' ? 400 : 403);
  });
  it.each(['../gateway', 'a'.repeat(65), '', 'bad/id'])('refuses invalid provider id %s', async (provider) => {
    // Given a registered project. When the id violates grant rules. Then the route refuses it.
    const response = await get(setup(), `provider?${new URLSearchParams({ directory: '/agent/project', provider })}`);
    expect(response.status).toBe(400);
  });
  it.each(['OPENCHAMBER_AGENT_SERVER_TOKEN', 'OPENCODE_PASSWORD', 'HERMES_OC_TOKEN_X', 'UI_PASSWORD', 'NODE_OPTIONS',
    'SSH_AUTH_SOCK', 'GIT_CONFIG', 'DOCKER_AUTH_CONFIG', 'CREDENTIALS_DIRECTORY', 'MODEL-KEY', 'a'.repeat(257)])('refuses internal or invalid env name %s', async (name) => {
    // Given an internal or malformed variable name. When read as a model key. Then the value never leaves.
    const response = await get(setup(), `secret?${new URLSearchParams({ name })}`);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ code: 'agent_host_credential_invalid_request' });
  });
  it.each(['secret?name=MODEL_KEY&name=OTHER', 'secret?name=MODEL_KEY&extra=1', 'providers?directory=/agent/project&directory=/other'])('refuses ambiguous query %s', async (query) => {
    // Given ambiguous input. When parsed. Then it is refused before use.
    expect((await get(setup(), query)).status).toBe(400);
  });
  it('returns the named key and explicit absence', async () => {
    // Given the agent environment. When reading a set and unset name. Then absence is distinct from transport failure.
    expect((await get(setup(), 'secret?name=MODEL_KEY')).body).toEqual({ value: 'agent-key' });
    expect((await get(setup(), 'secret?name=ABSENT')).body).toEqual({ value: null });
  });
  it('does not resolve custom-provider env references to internal configuration', async () => {
    // Given a provider referencing a control token. When granted. Then its env key is unavailable.
    const app = setup({ readLayers: () => ({ userConfig: { providers: { gateway: { ...definition, env: ['OPENCHAMBER_UI_PASSWORD'] } } } }) });
    expect((await get(app, 'provider?directory=/agent/project&provider=gateway')).body.key).toBeNull();
  });
  it('refuses oversized values without echoing secrets', async () => {
    // Given a value beyond the key cap. When requested. Then only a stable error code leaves.
    const response = await get(setup({ environment: { MODEL_KEY: 's'.repeat(8193) } }), 'secret?name=MODEL_KEY');
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ code: 'agent_host_credential_invalid_response' });
  });
  it('bounds the complete serialized answer', async () => {
    // Given individually valid large headers. When the complete definition exceeds the byte cap. Then it is refused.
    const headers = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`x-${i}`, 's'.repeat(8192)]));
    const app = setup({ readLayers: () => ({ userConfig: { providers: { gateway: { ...definition, headers } } } }) });
    expect((await get(app, 'provider?directory=/agent/project&provider=gateway')).body).toEqual({ code: 'agent_response_too_large' });
  });
  it('rejects malformed stored credentials at the agent route', async () => {
    // Given a malformed local OpenCode answer. When delegated. Then no raw row leaves the agent.
    const app = setup({ credentialSource: { list: async () => [{ id: 'bad' }] } });
    expect((await get(app, 'credentials')).body).toEqual({ code: 'agent_host_credential_invalid_response' });
  });
  it.each(['none', 'key', 'other-method'])('refuses renewed login when the selected credential is %s', async (kind) => {
    // Given no matching selected browser login.
    const value = { type: 'oauth', methodID: 'chatgpt-browser', access: 'synthetic-access', refresh: 'synthetic-refresh', expires: 999 };
    const rows = kind === 'none' ? [] : [{ id: 'cred_old', integrationID: 'openai', label: 'default', active: true,
      value: kind === 'key' ? { type: 'key', key: 'synthetic' } : { ...value, methodID: 'codex' } }];
    let creates = 0;
    const app = setup({ credentialSource: { list: async () => rows, create: async () => { creates += 1; } } });
    // When a renewed token arrives. Then it cannot establish a new login or change its method.
    const response = await request(app).post(`${ROUTE}/renewed-login`).set('authorization', 'Bearer synthetic')
      .send({ integrationID: 'openai', label: 'default', activate: true, value });
    expect(response.body).toEqual({ code: 'agent_login_not_selected' });
    expect(creates).toBe(0);
  });
  it.each(['{"value":"synthetic-secret",', JSON.stringify({ padding: 's'.repeat(256 * 1024) })])('keeps invalid renewal bodies out of errors', async (body) => {
    // Given malformed or oversized JSON. When renewal parses it. Then only a stable error code leaves.
    const response = await request(setup()).post(`${ROUTE}/renewed-login`).set('authorization', 'Bearer synthetic').set('content-type', 'application/json').send(body);
    expect(response.body).toEqual({ code: 'agent_host_credential_invalid_request' });
  });
});

describe('front-door host credential readers', () => {
  it('reconstructs data and binds the provider identity to the requested id', async () => {
    // Given an answer with extra authority claims. When read. Then claims are dropped and id substitution fails.
    const value = { id: 'gateway', name: 'Gateway', package: definition.package, baseURL: null, models: {}, headers: {}, key: 'agent-key', spaceId: 'forged' };
    const reader = createAgentHostCredentials(upstreamReply(value));
    expect(await reader.hostProviders.read('gateway', '/agent/project')).toEqual({ ...value, spaceId: undefined });
    await expect(reader.hostProviders.read('other', '/agent/project')).rejects.toMatchObject({ code: 'agent_host_credential_invalid_response' });
  });
  it.each([{}, { value: 42 }, { value: 's'.repeat(8193) }])('rejects malformed secret reply', async (value) => {
    // Given an invalid answer. When read. Then it fails explicitly.
    await expect(createAgentHostCredentials(upstreamReply(value)).readHostSecret('MODEL_KEY')).rejects.toMatchObject({ code: 'agent_host_credential_invalid_response' });
  });
  it('enforces the byte cap before JSON parsing', async () => {
    // Given an oversized untrusted response. When read. Then byte refusal wins over its invalid JSON.
    const upstream = { request: async () => Object.assign(Readable.from(['x'.repeat(MAX_HOST_CREDENTIAL_BYTES + 1)]), { complete: true }) };
    await expect(createAgentHostCredentials(upstream).readHostSecret('MODEL_KEY')).rejects.toMatchObject({ code: 'agent_response_too_large' });
  });
  it('keeps failure distinct from an absent key', async () => {
    // Given an unreachable agent and a hostile error body. When read. Then neither becomes a local/empty success.
    const failed = { request: async () => { throw Object.assign(new Error('private details'), { code: 'agent_unreachable' }); } };
    await expect(createAgentHostCredentials(failed).readHostSecret('MODEL_KEY')).rejects.toMatchObject({ code: 'agent_unreachable', message: 'agent_unreachable' });
    await expect(createAgentHostCredentials(upstreamReply({ code: 'private details' }, 500)).readHostSecret('MODEL_KEY')).rejects.toMatchObject({ code: 'agent_host_credential_unavailable' });
  });
  it('uses the actual authenticated upstream transport for provider and key reads', async () => {
    // Given agent-only routes and a password-session stand-in on a free port.
    const app = setup();
    app.use((req, res, next) => next());
    const server = http.createServer((req, res) => {
      if (req.url === '/auth/session') { req.resume(); res.setHeader('set-cookie', 'oc_ui_session=synthetic; Max-Age=3600'); return res.end('{}'); }
      if (req.headers.cookie === 'oc_ui_session=synthetic') req.headers.authorization = 'Bearer synthetic';
      app(req, res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
    const upstream = createAgentUpstream({ url: `http://127.0.0.1:${server.address().port}`, token: 'synthetic' });
    cleanups.push(() => upstream.close());
    // When the front-door reader requests agent data. Then auth and the expected contracts hold.
    const reader = createAgentHostCredentials(upstream);
    expect(await reader.readHostSecret('MODEL_KEY')).toBe('agent-key');
    expect(await reader.hostProviders.list('/agent/project')).toHaveLength(1);
  });
});
