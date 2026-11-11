import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureOpenCodeCredentials, readOpenCodeCredentials } from '../../../opencode/auth.js';
import { fetchGoogleQuota, isConfigured } from './index.js';
import { listConfiguredQuotaProviders } from '../../providers/index.js';
import { refreshAntigravityToken } from '../antigravity/api.js';

const GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const COMMON_AUTH_PLACEHOLDER = 'common-auth-placeholder.google';

const nativeGooglePlaceholderEntry = (overrides = {}) => ({
  id: 'test-google', integrationID: 'google', label: 'default', active: true,
  value: {
    type: 'oauth', methodID: 'oauth', metadata: { commonAuthPlaceholder: true },
    access: COMMON_AUTH_PLACEHOLDER,
    refresh: COMMON_AUTH_PLACEHOLDER,
    expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
    ...overrides,
  },
});

const configureCredentials = (...entries) => configureOpenCodeCredentials({ list: async () => entries });

const stubUnexpectedFetch = () => {
  const requests = [];
  vi.stubGlobal('fetch', async (url) => {
    requests.push(String(url));
    throw new Error('Unexpected Google request');
  });
  return requests;
};

const expectGooglePlaceholderRefused = async () => {
  const requests = stubUnexpectedFetch();
  const configured = isConfigured(await readOpenCodeCredentials());
  const providers = await listConfiguredQuotaProviders();
  const result = await fetchGoogleQuota();

  expect(requests).toEqual([]);
  expect(configured).toBe(false);
  expect(providers).not.toContain('google');
  expect(result).toMatchObject({ ok: false, configured: false, error: 'Not configured' });
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  configureOpenCodeCredentials(null);
});

const configureLogin = (refresh = 'test-refresh|test-project', expires = 1) => {
  configureOpenCodeCredentials({ list: async () => [{
    id: 'test-google', integrationID: 'google', label: 'default', active: true,
    value: { type: 'oauth', methodID: 'oauth', metadata: {}, access: 'old-access', refresh, expires },
  }] });
};

const stubGoogle = (exchange, { access = 'new-access', project = 'test-project', refreshToken = 'test-refresh' } = {}) => {
  const clients = [];
  const requests = [];
  vi.stubGlobal('fetch', async (url, options) => {
    requests.push(String(url));
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(options.body);
      expect(body.get('refresh_token')).toBe(refreshToken);
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(options.redirect).toBe('error');
      expect(options.signal).toBeInstanceOf(AbortSignal);
      const client = body.get('client_id');
      clients.push(client);
      return exchange(client, options);
    }
    expect(new Headers(options.headers).get('Authorization')).toBe(`Bearer ${access}`);
    expect(JSON.parse(options.body).project).toBe(project);
    if (url.endsWith(':retrieveUserQuota')) return Response.json({ buckets: [] });
    return Response.json({ models: { 'gemini-test': { quotaInfo: { remainingFraction: 0.75 } } } });
  });
  return { clients, requests };
};

describe('Google quota OAuth client compatibility', () => {
  it('does not dispatch a native placeholder or fall through to google.oauth', async () => {
    configureCredentials(nativeGooglePlaceholderEntry(), {
      id: 'test-google-oauth-alias', integrationID: 'google.oauth', label: 'default', active: true,
      value: {
        type: 'oauth', methodID: 'oauth', metadata: {}, access: 'alias-access',
        refresh: 'alias-refresh', expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
      },
    });
    await expectGooglePlaceholderRefused();
  });

  it('does not exchange a native placeholder after its access expires', async () => {
    configureCredentials(nativeGooglePlaceholderEntry({ expires: 1 }));
    await expectGooglePlaceholderRefused();
  });

  it('does not dispatch when only access starts with the placeholder prefix', async () => {
    configureCredentials(nativeGooglePlaceholderEntry({ refresh: 'ordinary-refresh' }));
    await expectGooglePlaceholderRefused();
  });

  it('does not exchange when only refresh starts with the placeholder prefix', async () => {
    configureCredentials(nativeGooglePlaceholderEntry({ access: '', expires: 1 }));
    await expectGooglePlaceholderRefused();
  });

  it('refuses the whole row when an otherwise-valid access token has a placeholder refresh', async () => {
    configureCredentials(nativeGooglePlaceholderEntry({
      access: 'ordinary-access',
      refresh: COMMON_AUTH_PLACEHOLDER,
      expires: Date.now() + 3_600_000,
    }));
    await expectGooglePlaceholderRefused();
  });

  it('accepts ordinary OAuth tokens with embedded placeholder text', async () => {
    const accessToken = 'opaque.common-auth-placeholder.google.access';
    configureCredentials(nativeGooglePlaceholderEntry({
      methodID: 'synthetic-method',
      access: accessToken,
      refresh: 'test-refresh|test-project',
      expires: Date.now() + 3_600_000,
    }));
    const accessRequests = stubGoogle(() => { throw new Error('Unexpected refresh'); }, { access: accessToken, project: 'test-project' });
    const accessResult = await fetchGoogleQuota();
    expect(accessResult.ok).toBe(true);
    expect(accessResult.configured).toBe(true);
    expect(accessRequests.clients).toEqual([]);
    expect(accessRequests.requests).toHaveLength(2);

    const refreshToken = 'opaque.common-auth-placeholder.google.refresh';
    configureCredentials(nativeGooglePlaceholderEntry({
      methodID: 'synthetic-method',
      access: '',
      refresh: refreshToken,
      expires: 1,
    }));
    const refreshRequests = stubGoogle(
      () => Response.json({ access_token: 'new-access' }),
      { refreshToken, project: 'rising-fact-p41fc' },
    );
    const refreshResult = await fetchGoogleQuota();
    expect(refreshResult.ok).toBe(true);
    expect(refreshResult.configured).toBe(true);
    expect(refreshRequests.clients).toEqual([GEMINI_CLIENT_ID]);
    expect(refreshRequests.requests).toHaveLength(3);
  });

  it('keeps Gemini CLI as the first client even for pipe-packed refresh tokens', async () => {
    configureLogin();
    const { clients } = stubGoogle(() => Response.json({ access_token: 'new-access' }));
    const result = await fetchGoogleQuota();
    expect(result.ok).toBe(true);
    expect(result.usage.models['gemini/gemini-test'].windows.daily.usedPercent).toBe(25);
    expect(clients).toEqual([GEMINI_CLIENT_ID]);
  });

  it('refreshes an ambiguous Antigravity login after Gemini rejects its client', async () => {
    configureLogin();
    const { clients } = stubGoogle((client) => client === GEMINI_CLIENT_ID
      ? Response.json({ error: 'unauthorized_client', error_description: 'Unauthorized' }, { status: 401 })
      : Response.json({ access_token: 'new-access' }));
    const result = await fetchGoogleQuota();
    expect(result.ok).toBe(true);
    expect(clients).toEqual([GEMINI_CLIENT_ID, ANTIGRAVITY_CLIENT_ID]);
    expect(JSON.stringify(result)).not.toContain('test-refresh');
    expect(JSON.stringify(result)).not.toContain('new-access');
  });

  it('supports plain tokens and HTTP 400 client rejection without changing model keys', async () => {
    configureLogin('test-refresh');
    const { clients } = stubGoogle((client) => client === GEMINI_CLIENT_ID
      ? Response.json({ error: 'unauthorized_client' }, { status: 400 })
      : Response.json({ access_token: 'new-access' }), { project: 'rising-fact-p41fc' });
    const result = await fetchGoogleQuota();
    expect(result.ok).toBe(true);
    expect(Object.keys(result.usage.models)).toEqual(['gemini/gemini-test']);
    expect(clients).toEqual([GEMINI_CLIENT_ID, ANTIGRAVITY_CLIENT_ID]);
  });

  it('uses a valid access token without exchanging the refresh token', async () => {
    configureLogin('test-refresh|test-project', Date.now() + 3_600_000);
    const { clients, requests } = stubGoogle(() => { throw new Error('Unexpected refresh'); }, { access: 'old-access' });
    expect((await fetchGoogleQuota()).ok).toBe(true);
    expect(clients).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  const excludedFailures = [
    ['invalid grant', () => Response.json({ error: 'invalid_grant', error_description: 'sensitive-response' }, { status: 400 })],
    ['invalid client', () => Response.json({ error: 'invalid_client' }, { status: 401 })],
    ['bare 401', () => Response.json({}, { status: 401 })],
    ['unknown error', () => Response.json({ error: 'sensitive-response' }, { status: 401 })],
    ['rate limiting', () => Response.json({ error: 'unauthorized_client' }, { status: 429 })],
    ['server failure', () => Response.json({ error: 'unauthorized_client' }, { status: 503 })],
    ['forbidden', () => Response.json({ error: 'unauthorized_client' }, { status: 403 })],
    ['malformed rejection', () => new Response('{', { status: 401 })],
    ['malformed success', () => new Response('{')],
    ['missing access', () => Response.json({})],
    ['empty access', () => Response.json({ access_token: ' ' })],
    ['network failure', () => { throw new Error('sensitive-response'); }],
    ['timeout', () => { throw new DOMException('sensitive-response', 'TimeoutError'); }],
  ];

  for (const [name, response] of excludedFailures) {
    it(`does not try another client on ${name}`, async () => {
      configureLogin();
      let quotaCalls = 0;
      const clients = [];
      vi.stubGlobal('fetch', async (url, options) => {
        if (url !== 'https://oauth2.googleapis.com/token') {
          quotaCalls++;
          throw new Error('Unexpected quota request');
        }
        clients.push(new URLSearchParams(options.body).get('client_id'));
        return response();
      });
      const result = await fetchGoogleQuota();
      expect(result.ok).toBe(false);
      expect(result.configured).toBe(true);
      expect(result.usage).toBeNull();
      expect(result.error).toBe('Gemini: Failed to refresh OAuth token');
      expect(clients).toEqual([GEMINI_CLIENT_ID]);
      expect(quotaCalls).toBe(0);
      expect(JSON.stringify(result)).not.toContain('sensitive-response');
      expect(JSON.stringify(result)).not.toContain('test-refresh');
    });
  }

  it('stops after the alternate client fails and keeps the credential unchanged', async () => {
    const entry = {
      id: 'test-google', integrationID: 'google', label: 'default', active: true,
      value: { type: 'oauth', methodID: 'oauth', access: 'old-access', refresh: 'test-refresh|test-project', expires: 1 },
    };
    const before = structuredClone(entry);
    configureOpenCodeCredentials({ list: async () => [entry], create: () => { throw new Error('Unexpected credential write'); }, remove: () => { throw new Error('Unexpected credential deletion'); } });
    const clients = [];
    vi.stubGlobal('fetch', async (url, options) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      clients.push(new URLSearchParams(options.body).get('client_id'));
      return Response.json({ error: 'unauthorized_client', error_description: 'sensitive-response' }, { status: 401 });
    });
    const result = await fetchGoogleQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Gemini: Failed to refresh OAuth token');
    expect(clients).toEqual([GEMINI_CLIENT_ID, ANTIGRAVITY_CLIENT_ID]);
    expect(entry).toEqual(before);
    expect(JSON.stringify(result)).not.toContain('sensitive-response');
  });

  it('reports the alternate client failure without trying a third exchange', async () => {
    configureLogin();
    const clients = [];
    vi.stubGlobal('fetch', async (url, options) => {
      expect(url).toBe('https://oauth2.googleapis.com/token');
      const client = new URLSearchParams(options.body).get('client_id');
      clients.push(client);
      return Response.json({ error: client === GEMINI_CLIENT_ID ? 'unauthorized_client' : 'invalid_grant' }, { status: 400 });
    });
    const result = await fetchGoogleQuota();
    expect(result.error).toBe('Gemini: Failed to refresh OAuth token');
    expect(clients).toEqual([GEMINI_CLIENT_ID, ANTIGRAVITY_CLIENT_ID]);
  });

  for (const status of [200, 401]) {
    it(`preserves a body transport failure after HTTP ${status} headers`, async () => {
      configureLogin();
      const { clients } = stubGoogle(() => new Response(new ReadableStream({
        start(controller) { controller.error(new Error('sensitive-response')); },
      }), { status }));
      const result = await fetchGoogleQuota();
      expect(result.error).toBe('Gemini: Failed to refresh OAuth token');
      expect(result.ok).toBe(false);
      expect(clients).toEqual([GEMINI_CLIENT_ID]);
      expect(JSON.stringify(result)).not.toContain('sensitive-response');
    });
  }

  it('preserves a body timeout after success headers', async () => {
    configureLogin();
    const { clients } = stubGoogle(() => new Response(new ReadableStream({
      start(controller) { controller.error(new DOMException('sensitive-response', 'TimeoutError')); },
    })));
    const result = await fetchGoogleQuota();
    expect(result.error).toBe('Gemini: Failed to refresh OAuth token');
    expect(clients).toEqual([GEMINI_CLIENT_ID]);
  });

  it('bounds body reads with the refresh deadline and recognizes an aborted body', async () => {
    configureLogin();
    const nativeTimeout = AbortSignal.timeout;
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      expect(milliseconds).toBe(15000);
      return nativeTimeout(1);
    });
    const { clients } = stubGoogle((_client, options) => new Response(new ReadableStream({
      start(controller) {
        options.signal.addEventListener('abort', () => controller.error(new DOMException('sensitive-response', 'AbortError')), { once: true });
      },
    })));
    const result = await fetchGoogleQuota();
    expect(result.error).toBe('Gemini: Failed to refresh OAuth token');
    expect(result.ok).toBe(false);
    expect(clients).toEqual([GEMINI_CLIENT_ID]);
  });

  it('reads the currently active login again after an account switch', async () => {
    configureLogin();
    const { clients } = stubGoogle((client) => client === GEMINI_CLIENT_ID
      ? Response.json({ error: 'unauthorized_client' }, { status: 401 })
      : Response.json({ access_token: 'new-access' }));
    expect((await fetchGoogleQuota()).ok).toBe(true);
    configureLogin('test-refresh|test-project', Date.now() + 3_600_000);
    const { clients: switchedClients } = stubGoogle(() => { throw new Error('Unexpected refresh'); }, { access: 'old-access' });
    expect((await fetchGoogleQuota()).ok).toBe(true);
    expect(clients).toEqual([GEMINI_CLIENT_ID, ANTIGRAVITY_CLIENT_ID]);
    expect(switchedClients).toEqual([]);
  });

  it('reports missing refresh tokens without querying quota with expired access', async () => {
    configureLogin('');
    const request = vi.fn(() => { throw new Error('Unexpected request'); });
    vi.stubGlobal('fetch', request);
    const result = await fetchGoogleQuota();
    expect(result.ok).toBe(false);
    expect(result.configured).toBe(true);
    expect(result.error).toBe('Gemini: Missing refresh token');
    expect(request).not.toHaveBeenCalled();
  });

  it('does not query any service without a Google credential', async () => {
    configureOpenCodeCredentials({ list: async () => [] });
    const request = vi.fn(() => { throw new Error('Unexpected request'); });
    vi.stubGlobal('fetch', request);
    const result = await fetchGoogleQuota();
    expect(result.configured).toBe(false);
    expect(result.error).toBe('Not configured');
    expect(request).not.toHaveBeenCalled();
  });

  it('preserves direct Antigravity refresh without probing Gemini', async () => {
    const { clients } = stubGoogle(() => Response.json({ access_token: 'new-access' }));
    expect(await refreshAntigravityToken('test-refresh')).toBe('new-access');
    expect(clients).toEqual([ANTIGRAVITY_CLIENT_ID]);
  });

  it('preserves direct Antigravity refresh failure as null', async () => {
    const { clients } = stubGoogle(() => Response.json({ error: 'unauthorized_client' }, { status: 401 }));
    expect(await refreshAntigravityToken('test-refresh')).toBeNull();
    expect(clients).toEqual([ANTIGRAVITY_CLIENT_ID]);
  });
});
