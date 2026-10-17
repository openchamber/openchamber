import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { configureOpenCodeCredentials } from './opencodeAuth';
import { fetchQuotaForProvider } from './quotaProviders';

const GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com';
const ANTIGRAVITY_CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  configureOpenCodeCredentials(null);
});

const configureLogin = (refresh = 'test-refresh|test-project|managed-project', expires = 1) => {
  configureOpenCodeCredentials({ list: async () => [{
    id: 'test-google', integrationID: 'google', label: 'default', active: true,
    value: { type: 'oauth', methodID: 'oauth', metadata: {}, access: 'old-access', refresh, expires },
  }] });
};

const stubGoogle = (
  exchange: (client: string | null, options?: RequestInit) => Response | Promise<Response>,
  accessToken = 'new-access',
  project?: string,
) => {
  const clients: Array<string | null> = [];
  const quotaRequests: string[] = [];
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://oauth2.googleapis.com/token') {
      assert.ok(options?.body instanceof URLSearchParams);
      assert.equal(options.body.get('refresh_token'), 'test-refresh');
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      assert.equal(options.method, 'POST');
      assert.equal(new Headers(options.headers).get('Content-Type'), 'application/x-www-form-urlencoded');
      const client = options.body.get('client_id');
      clients.push(client);
      return exchange(client, options);
    }
    quotaRequests.push(String(url));
    assert.equal(new Headers(options?.headers).get('Authorization'), `Bearer ${accessToken}`);
    if (project) assert.equal(options?.body, JSON.stringify({ project }));
    if (String(url).endsWith(':retrieveUserQuota')) {
      return Response.json({ buckets: [{ modelId: 'gemini-test', remainingFraction: 0.75 }] });
    }
    assert.ok(String(url).endsWith(':fetchAvailableModels'));
    return Response.json({ models: {} });
  };
  return { clients, quotaRequests };
};

const assertUsage = (result: Awaited<ReturnType<typeof fetchQuotaForProvider>>) => {
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.equal(result.usage?.models?.['gemini/gemini-test'].windows.daily.usedPercent, 25);
  assert.equal(result.usage?.models?.['gemini/gemini-test'].windows.daily.windowSeconds, 86400);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('test-refresh'));
  assert.ok(!serialized.includes('new-access'));
};

describe('VS Code Google quota OAuth client compatibility', () => {
  for (const refresh of ['test-refresh', 'test-refresh|test-project|managed-project']) {
    it(`uses Gemini once for ${refresh.includes('|') ? 'packed' : 'plain'} refresh tokens`, async () => {
      configureLogin(refresh);
      const requests = stubGoogle(() => Response.json({ access_token: 'new-access' }), 'new-access',
        refresh.includes('|') ? 'test-project' : undefined);
      assertUsage(await fetchQuotaForProvider('google'));
      assert.deepEqual(requests.clients, [GEMINI_CLIENT_ID]);
      assert.equal(requests.quotaRequests.length, 2);
    });
  }

  for (const status of [400, 401]) {
    it(`tries Antigravity after Gemini returns ${status} unauthorized_client`, async () => {
      configureLogin();
      const requests = stubGoogle((client) => client === GEMINI_CLIENT_ID
        ? Response.json({ error: 'unauthorized_client' }, { status })
        : Response.json({ access_token: 'new-access' }), 'new-access', 'test-project');
      assertUsage(await fetchQuotaForProvider('google'));
      assert.deepEqual(requests.clients, [GEMINI_CLIENT_ID, ANTIGRAVITY_CLIENT_ID]);
      assert.equal(requests.quotaRequests.length, 2);
    });
  }

  const failures = [
    { name: 'invalid_grant', response: () => Response.json({ error: 'invalid_grant' }, { status: 400 }) },
    { name: 'invalid_client', response: () => Response.json({ error: 'invalid_client' }, { status: 401 }) },
    { name: 'bare 401', response: () => new Response('', { status: 401 }) },
    { name: '429', response: () => Response.json({ error: 'unauthorized_client' }, { status: 429 }) },
    { name: '503', response: () => Response.json({ error: 'unauthorized_client' }, { status: 503 }) },
    { name: 'malformed error JSON', response: () => new Response('{', { status: 400 }) },
    { name: 'malformed success JSON', response: () => new Response('{') },
    { name: 'empty token', response: () => Response.json({ access_token: '' }) },
    { name: 'missing token', response: () => Response.json({}) },
    { name: 'network error', response: () => { throw new Error('network test-refresh new-access'); } },
    { name: 'timeout', response: () => { throw new DOMException('test-refresh new-access', 'TimeoutError'); } },
    { name: 'abort', response: () => { throw new DOMException('test-refresh new-access', 'AbortError'); } },
  ];
  for (const failure of failures) {
    it(`does not try another client or quota request after ${failure.name}`, async () => {
      configureLogin();
      const requests = stubGoogle(failure.response);
      const result = await fetchQuotaForProvider('google');
      assert.equal(result.ok, false);
      assert.equal(result.configured, true);
      assert.match(result.error ?? '', /^Gemini: Failed to refresh OAuth token/);
      assert.deepEqual(requests.clients, [GEMINI_CLIENT_ID]);
      assert.deepEqual(requests.quotaRequests, []);
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes('test-refresh'));
      assert.ok(!serialized.includes('new-access'));
    });
  }

  it('returns a redacted configured failure when the alternate client fails', async () => {
    configureLogin();
    const requests = stubGoogle((client, options) => {
      if (client === GEMINI_CLIENT_ID) return Response.json({ error: 'unauthorized_client' }, { status: 401 });
      assert.ok(options?.body instanceof URLSearchParams);
      return Response.json({
        error: 'invalid_grant',
        error_description: `test-refresh new-access ${options.body.get('client_secret')}`,
      }, { status: 400 });
    });
    const result = await fetchQuotaForProvider('google');
    assert.equal(result.ok, false);
    assert.equal(result.configured, true);
    assert.match(result.error ?? '', /^Gemini: Failed to refresh OAuth token/);
    assert.equal(result.error, 'Gemini: Failed to refresh OAuth token');
    assert.deepEqual(requests.clients, [GEMINI_CLIENT_ID, ANTIGRAVITY_CLIENT_ID]);
    assert.deepEqual(requests.quotaRequests, []);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes('test-refresh'));
    assert.ok(!serialized.includes('new-access'));
    assert.ok(!serialized.includes('GOCSPX'));
  });

  it('uses a valid access token without refreshing', async () => {
    configureLogin('test-refresh|test-project', Date.now() + 3600000);
    const requests = stubGoogle(() => { throw new Error('Unexpected refresh'); }, 'old-access', 'test-project');
    assertUsage(await fetchQuotaForProvider('google'));
    assert.deepEqual(requests.clients, []);
    assert.equal(requests.quotaRequests.length, 2);
  });
});
