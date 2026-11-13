import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getRuntimeUrlResolver, configureRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import {
  ProtectedMcpRequestError,
  completeProtectedOAuthFromAddress,
  createProtectedConnection,
  deleteProtectedConnection,
  getProtectedConnection,
  getProtectedOAuthAttempt,
  loadProtectedMcpStatus,
  protectedScopeAvailability,
  revokeProtectedCredentials,
  setProtectedConnectionEnabled,
  startProtectedOAuth,
  updateProtectedConnection,
  type ProtectedMcpStatus,
} from './protectedMcp';

// runtimeFetch is exercised for real: the runtime points at a test origin and
// `fetch` records each request, as runtime-fetch.test.ts does.
const ORIGIN = 'https://runtime.test';
type Recorded = { url: string; method: string; body: string; directoryHeader: string | null };
let requests: Recorded[] = [];
let answer: () => Response = () => new Response('{}');
const originalFetch = globalThis.fetch;
const originalResolver = getRuntimeUrlResolver();

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };
const json = (body: Json, status = 200) => () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  requests = [];
  configureRuntimeUrlResolver({ apiBaseUrl: ORIGIN });
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, method: request.method, body: await request.text(), directoryHeader: request.headers.get('x-opencode-directory') });
    return answer();
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setRuntimeUrlResolver(originalResolver);
});

const ID = 'pmcp_00000000000000a1';

/** The request error a call rejects with; any other outcome fails the test. */
const rejection = async (pending: Promise<object>): Promise<ProtectedMcpRequestError> => {
  try {
    await pending;
  } catch (error) {
    if (error instanceof ProtectedMcpRequestError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
};
const SENTINEL = 'pmcp-sentinel-3-never-in-engine';

const httpView = {
  id: ID,
  name: 'harness',
  revision: 4,
  enabled: true,
  transport: 'http',
  http: { url: 'https://mcp.example.test/mcp', headers: {} },
  policy: {},
  secrets: { api_key: { set: true }, oauth_client_secret: { set: false } },
  credential: 'authorization_required',
  oauth: { authorized: false, expiresAt: null, scope: null },
  editable: {
    name: 'harness',
    enabled: true,
    transport: 'http',
    http: {
      url: 'https://mcp.example.test/mcp',
      headers: { 'X-Api-Key': { secret: 'api_key', prefix: 'Key ' }, 'X-Team': 'blue' },
      oauth: { scopes: ['openid'], clientId: 'mcp-client', clientSecret: { secret: 'oauth_client_secret' }, issuer: 'https://issuer.test', redirectUri: 'https://fixed.test/cb' },
    },
    policy: { allowTools: ['read_*'], denyTools: ['harness_delete'], defaultArguments: { org_id: 'org' } },
  },
};

const stdioView = {
  id: ID,
  name: 'pkg',
  revision: 1,
  enabled: false,
  transport: 'stdio',
  secrets: { token: { set: true } },
  credential: 'stored',
  runtime: 'installing',
  editable: {
    name: 'pkg',
    enabled: false,
    transport: 'stdio',
    stdio: {
      command: { package: '@scope/mcp', version: '1.2.3', bin: 'mcp' },
      args: ['--flag', { state: 'cache' }],
      env: { TOKEN: { secret: 'token' }, KEYFILE: { secretFile: 'key' }, CACHE: { state: 'cache' }, MODE: 'ro' },
    },
    policy: {},
  },
};

const statusWith = (service: Json) => ({
  host: { supported: true },
  service,
  selections: { global: {}, project: null, effective: {} },
  selectionsError: null,
});

const available = {
  state: 'available',
  status: {
    protocol: 1,
    administration: 'shared',
    enforcement: { status: 'protected', checkedAt: 1, findings: [{ code: 'admin_socket_shared', level: 'warning', subject: '/run/x' }, { code: 'not_checked', level: 'unknown' }] },
    connections: [{ id: ID, name: 'harness', revision: 4, enabled: true, transport: 'http', target: { kind: 'url', label: 'mcp.example.test' }, credential: 'authorized' }],
  },
};

describe('protected MCP status', () => {
  test('an available service is read with its administration and findings', async () => {
    answer = json(statusWith(available));
    const state = await loadProtectedMcpStatus('/work/project');
    expect(requests[0]).toEqual({ url: `${ORIGIN}/api/protected-mcp/status?directory=%2Fwork%2Fproject`, method: 'GET', body: '', directoryHeader: '/work/project' });
    if (state.kind !== 'ready' || state.status.service.state !== 'available') throw new Error(`unexpected ${state.kind}`);
    expect(state.status.service.status.administration).toBe('shared');
    expect(state.status.service.status.enforcement.findings).toEqual([
      { code: 'admin_socket_shared', level: 'warning', subject: '/run/x' },
      { code: 'not_checked', level: 'unknown' },
    ]);
    expect(state.status.service.status.connections.map((connection) => connection.id)).toEqual([ID]);
  });

  for (const serviceState of ['unreachable', 'permission_denied', 'invalid_response', 'not_installed', 'invalid_client_config', 'unsupported_platform'] as const) {
    test(`the service state ${serviceState} is read as itself`, async () => {
      answer = json(statusWith({ state: serviceState }));
      const state = await loadProtectedMcpStatus(null);
      expect(requests[0]?.url).toBe(`${ORIGIN}/api/protected-mcp/status`);
      expect(state.kind === 'ready' ? state.status.service.state : state.kind).toBe(serviceState);
    });
  }

  test('a status with a field this version does not know is still read', async () => {
    answer = json(statusWith({ state: 'unreachable', retiredField: 'ignored' }));
    const state = await loadProtectedMcpStatus(null);
    expect(state.kind === 'ready' ? state.status.service : null).toEqual({ state: 'unreachable' });
  });

  const failures: [string, () => Response][] = [
    ['an unknown service state', json(statusWith({ state: 'exploded' }))],
    ['an available service without administration', json(statusWith({ ...available, status: { ...available.status, administration: undefined } }))],
    ['a finding with an unknown level', json(statusWith({ ...available, status: { ...available.status, enforcement: { status: 'protected', findings: [{ code: 'x', level: 'fatal' }] } } }))],
    ['a body that is not JSON', () => new Response('<html>', { status: 200 })],
    ['a server error', json({ code: 'internal_error', error: 'internal_error' }, 500)],
  ];
  for (const [label, response] of failures) {
    test(`${label} is a failed read, never an empty list`, async () => {
      answer = response;
      expect(await loadProtectedMcpStatus(null)).toEqual({ kind: 'failed' });
    });
  }

  test('a host without the routes is unsupported', async () => {
    answer = json({ code: 'unsupported' }, 501);
    expect(await loadProtectedMcpStatus(null)).toEqual({ kind: 'unsupported' });
    answer = () => new Response('not found', { status: 404 });
    expect(await loadProtectedMcpStatus(null)).toEqual({ kind: 'unsupported' });
  });
});

describe('protected connection admin view', () => {
  test('V7-2: keeps the parsed raw editable beside the tagged form with optional fields intact', async () => {
    // Given a broker definition with explicitly empty optional fields.
    const editable = {
      ...httpView.editable,
      http: { ...httpView.editable.http, headers: { 'X-Api-Key': { secret: 'api_key', prefix: '' } }, oauth: { scopes: [], clientId: '', clientSecret: { secret: 'oauth_client_secret' } } },
      policy: { allowTools: [], denyTools: [], defaultArguments: {} },
    };
    answer = json({ connection: { ...httpView, editable } });
    // When the API boundary parses the response.
    const view = await getProtectedConnection(ID);
    // Then rawEditable retains the broker grammar, while editable still exposes tagged values.
    expect(view.rawEditable).toEqual(editable);
    expect(view.editable.transport === 'http' ? view.editable.http.headers['X-Api-Key'] : null).toMatchObject({ kind: 'secret', slot: 'api_key' });
  });

  test('an http view tags its headers and keeps OAuth and secret flags', async () => {
    answer = json({ connection: httpView });
    const view = await getProtectedConnection(ID);
    expect(requests[0]).toMatchObject({ url: `${ORIGIN}/api/protected-mcp/connections/${ID}`, method: 'GET' });
    expect(view.secrets).toEqual({ api_key: { set: true }, oauth_client_secret: { set: false } });
    expect(view.oauth).toEqual({ authorized: false, expiresAt: null, scope: null });
    expect(view.credential).toBe('authorization_required');
    if (view.editable.transport !== 'http') throw new Error('expected http');
    expect(view.editable.http.headers).toEqual({
      'X-Api-Key': { kind: 'secret', slot: 'api_key', prefix: 'Key ' },
      'X-Team': { kind: 'text', text: 'blue' },
    });
    expect(view.editable.http.oauth?.redirectUri).toBe('https://fixed.test/cb');
    expect(view.editable.policy).toEqual({ allowTools: ['read_*'], denyTools: ['harness_delete'], defaultArguments: { org_id: 'org' } });
  });

  test('a stdio view tags its command, arguments and environment and keeps the runtime', async () => {
    answer = json({ connection: stdioView });
    const view = await getProtectedConnection(ID);
    expect(view.runtime).toBe('installing');
    if (view.editable.transport !== 'stdio') throw new Error('expected stdio');
    expect(view.editable.stdio).toEqual({
      command: { kind: 'package', package: '@scope/mcp', version: '1.2.3', bin: 'mcp' },
      args: [{ kind: 'text', value: '--flag' }, { kind: 'state', value: 'cache' }],
      env: {
        TOKEN: { kind: 'secret', slot: 'token' },
        KEYFILE: { kind: 'secretFile', slot: 'key' },
        CACHE: { kind: 'state', text: 'cache' },
        MODE: { kind: 'text', text: 'ro' },
      },
    });
  });

  test('a view with an unknown runtime is an invalid response', async () => {
    answer = json({ connection: { ...stdioView, runtime: 'broken' } });
    const error = await rejection(getProtectedConnection(ID));
    expect([error.code, error.status]).toEqual(['invalid_response', 200]);
  });
});

describe('protected MCP request errors', () => {
  const failureOf = async (response: () => Response) => {
    answer = response;
    const error = await rejection(updateProtectedConnection(ID, { expectedRevision: 1, definition: { name: 'x', enabled: true, transport: 'http', http: { url: 'https://x.test', headers: {} }, policy: {} }, secrets: {} }));
    return { code: error.code, message: error.message, status: error.status, field: error.field };
  };

  test('a definition error names the field the broker refused', async () => {
    expect(await failureOf(json({ code: 'invalid_secret_slot', error: 'invalid_secret_slot: stdio.env.TOKEN' }, 400)))
      .toEqual({ code: 'invalid_secret_slot', message: 'invalid_secret_slot: stdio.env.TOKEN', status: 400, field: 'stdio.env.TOKEN' });
  });

  test('an error without a field has none', async () => {
    expect(await failureOf(json({ code: 'revision_conflict', error: 'The connection changed' }, 409)))
      .toEqual({ code: 'revision_conflict', message: 'The connection changed', status: 409, field: null });
    expect(await failureOf(json({ code: 'invalid_definition', error: 'invalid_definition' }, 400)))
      .toEqual({ code: 'invalid_definition', message: 'invalid_definition', status: 400, field: null });
  });

  test('an error body without a message keeps the code', async () => {
    expect(await failureOf(json({ code: 'service_unavailable' }, 503)))
      .toEqual({ code: 'service_unavailable', message: 'service_unavailable', status: 503, field: null });
  });

  test('an error body that is not JSON becomes the HTTP status', async () => {
    expect(await failureOf(() => new Response('Bad gateway', { status: 502 })))
      .toEqual({ code: 'http_502', message: 'http_502', status: 502, field: null });
  });
});

describe('protected MCP API requests', () => {
  const definition = { name: 'gh', enabled: true, transport: 'stdio' as const, stdio: { command: '/usr/bin/gh-mcp', args: [], env: { TOKEN: { secret: 'token' } } }, policy: {} };
  const viewAnswer = json({ connection: stdioView });
  const sent = () => requests.map(({ url, method, body, directoryHeader }) => ({ url: url.replace(ORIGIN, ''), method, body: body ? JSON.parse(body) : null, directoryHeader }));

  test('create posts the definition, the typed secrets and the use, scoped to the directory', async () => {
    answer = json({ connection: stdioView, selections: { project: { gh: { connection: ID } } } }, 201);
    const view = await createProtectedConnection({ definition, secrets: { token: SENTINEL }, use: { scope: 'project' } }, '/work/a b');
    expect(view.id).toBe(ID);
    expect(sent()).toEqual([{
      url: '/api/protected-mcp/connections?directory=%2Fwork%2Fa%20b',
      method: 'POST',
      body: { definition, secrets: { token: SENTINEL }, use: { scope: 'project' } },
      directoryHeader: '/work/a b',
    }]);
  });

  test('update, enabled and revoke send the revision they were built from', async () => {
    answer = viewAnswer;
    await updateProtectedConnection(ID, { expectedRevision: 7, definition, secrets: {} });
    answer = viewAnswer;
    await setProtectedConnectionEnabled(ID, { expectedRevision: 8, enabled: false });
    answer = viewAnswer;
    await revokeProtectedCredentials(ID, { expectedRevision: 9 });
    expect(sent()).toEqual([
      { url: `/api/protected-mcp/connections/${ID}`, method: 'PUT', body: { expectedRevision: 7, definition, secrets: {} }, directoryHeader: null },
      { url: `/api/protected-mcp/connections/${ID}/enabled`, method: 'PUT', body: { expectedRevision: 8, enabled: false }, directoryHeader: null },
      { url: `/api/protected-mcp/connections/${ID}/revoke`, method: 'POST', body: { expectedRevision: 9 }, directoryHeader: null },
    ]);
  });

  test('delete sends the revision and reports the selection files left untouched', async () => {
    answer = json({ removed: true, selectionsRemoved: 2, selectionsNotUpdated: ['project-ab.json'] });
    expect(await deleteProtectedConnection(ID, { expectedRevision: 3 })).toEqual(['project-ab.json']);
    expect(sent()).toEqual([{ url: `/api/protected-mcp/connections/${ID}`, method: 'DELETE', body: { expectedRevision: 3 }, directoryHeader: null }]);
  });

  test('OAuth start, attempt and the paste fallback use their routes', async () => {
    answer = json({ attempt: 'AAAAAAAAAAAAAAAAAAAAAA', authorizationUrl: 'https://issuer.test/authorize?state=s' });
    expect(await startProtectedOAuth(ID, { expectedRevision: 4 })).toEqual({ attempt: 'AAAAAAAAAAAAAAAAAAAAAA', authorizationUrl: 'https://issuer.test/authorize?state=s' });
    answer = json({ status: 'done', outcome: 'authorized' });
    expect(await getProtectedOAuthAttempt('AAAAAAAAAAAAAAAAAAAAAA')).toEqual({ status: 'done', outcome: 'authorized' });
    answer = json({ outcome: 'oauth_state_invalid', name: null });
    expect(await completeProtectedOAuthFromAddress('https://fixed.test/cb?state=s&code=c')).toEqual({ outcome: 'oauth_state_invalid', name: null });
    expect(sent()).toEqual([
      { url: `/api/protected-mcp/connections/${ID}/oauth`, method: 'POST', body: { expectedRevision: 4 }, directoryHeader: null },
      { url: '/api/protected-mcp/oauth/attempts/AAAAAAAAAAAAAAAAAAAAAA', method: 'GET', body: null, directoryHeader: null },
      { url: '/api/protected-mcp/oauth/complete', method: 'POST', body: { address: 'https://fixed.test/cb?state=s&code=c' }, directoryHeader: null },
    ]);
  });

  test('an attempt status outside the contract is an invalid response', async () => {
    answer = json({ status: 'maybe' });
    expect((await rejection(getProtectedOAuthAttempt('AAAAAAAAAAAAAAAAAAAAAA'))).code).toBe('invalid_response');
  });
});

describe('protected scope availability', () => {
  const ready = (service: ProtectedMcpStatus['service'], supported = true) => ({
    kind: 'ready' as const,
    status: { host: { supported }, service, selections: null, selectionsError: null },
  });
  const availableService: ProtectedMcpStatus['service'] = {
    state: 'available',
    status: { administration: 'shared', enforcement: { status: 'protected', findings: [] }, connections: [] },
  };

  test('hidden while loading, where the feature does not exist, and where the service cannot be', () => {
    const hidden = { visible: false, disabledReason: null };
    expect(protectedScopeAvailability({ kind: 'loading' })).toEqual(hidden);
    expect(protectedScopeAvailability({ kind: 'unsupported' })).toEqual(hidden);
    expect(protectedScopeAvailability(ready(availableService, false))).toEqual(hidden);
    expect(protectedScopeAvailability(ready({ state: 'not_installed' }))).toEqual(hidden);
    expect(protectedScopeAvailability(ready({ state: 'unsupported_platform' }))).toEqual(hidden);
  });

  test('shown and disabled with the reason while the service is there but not usable', () => {
    expect(protectedScopeAvailability({ kind: 'failed' })).toEqual({ visible: true, disabledReason: 'settings.mcp.protected.loadFailed' });
    expect(protectedScopeAvailability(ready({ state: 'unreachable' }))).toEqual({ visible: true, disabledReason: 'settings.mcp.protected.service.unreachable' });
    expect(protectedScopeAvailability(ready({ state: 'permission_denied' }))).toEqual({ visible: true, disabledReason: 'settings.mcp.protected.service.permissionDenied' });
    expect(protectedScopeAvailability(ready({ state: 'invalid_response' }))).toEqual({ visible: true, disabledReason: 'settings.mcp.protected.service.invalid' });
    expect(protectedScopeAvailability(ready({ state: 'invalid_client_config' }))).toEqual({ visible: true, disabledReason: 'settings.mcp.protected.service.invalid' });
  });

  test('enabled when the service is available', () => {
    expect(protectedScopeAvailability(ready(availableService))).toEqual({ visible: true, disabledReason: null });
  });
});
