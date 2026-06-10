import { describe, expect, test } from 'bun:test';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { buildRuntimeFetchUrl, runtimeFetch } from './runtime-fetch';
import { clearRuntimeAuthCredentialProvider, setRuntimeBearerToken } from './runtime-auth';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

const originalFetch = globalThis.fetch;

describe('buildRuntimeFetchUrl', () => {
  test('preserves same-origin paths by default', () => {
    expect(buildRuntimeFetchUrl('/api/config/settings')).toBe('/api/config/settings');
    expect(buildRuntimeFetchUrl('/auth/session')).toBe('/auth/session');
    expect(buildRuntimeFetchUrl('/health')).toBe('/health');
  });

  test('resolves API/auth/health through configured runtime URL resolver', () => {
    const previous = getRuntimeUrlResolver();
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });

      expect(buildRuntimeFetchUrl('/api/config/settings')).toBe('https://api.example/api/config/settings');
      expect(buildRuntimeFetchUrl('/auth/session')).toBe('https://api.example/auth/session');
      expect(buildRuntimeFetchUrl('/health')).toBe('https://api.example/health');
      expect(buildRuntimeFetchUrl('/api/find/file', { query: 'x' })).toBe('https://api.example/api/find/file?query=x');
    } finally {
      setRuntimeUrlResolver(previous);
    }
  });

  test('rewrites current-origin absolute API URLs only', () => {
    const previous = getRuntimeUrlResolver();
    const originalWindow = globalThis.window;
    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://api.example' });
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'openchamber-ui://app', href: 'openchamber-ui://app/index.html' } },
      });

      expect(buildRuntimeFetchUrl('openchamber-ui://app/api/config/settings')).toBe('https://api.example/api/config/settings');
      expect(buildRuntimeFetchUrl('https://external.example/api/config/settings')).toBe('https://external.example/api/config/settings');
    } finally {
      setRuntimeUrlResolver(previous);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });
});

describe('runtimeFetch transport contract', () => {
  test('preserves bodies from actual SDK mutation requests on same-origin runtimes', async () => {
    const previous = getRuntimeUrlResolver();
    const originalWindow = globalThis.window;
    const calls: Array<{ url: string; method: string; body: string; headers: Headers }> = [];

    try {
      configureRuntimeUrlResolver({});
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'https://app.example', href: 'https://app.example/' } },
      });

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        calls.push({
          url: request.url,
          method: request.method,
          body: await request.clone().text(),
          headers: request.headers,
        });
        return new Response(JSON.stringify({ ok: true, id: 'ses_1', time: { created: 1 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as typeof fetch;

      const client = createOpencodeClient({
        baseUrl: 'https://app.example/api',
        fetch: runtimeFetch,
      });

      await client.session.revert({ sessionID: 'ses_1', directory: '/repo', messageID: 'msg_1' });
      await client.session.shell({
        sessionID: 'ses_1',
        directory: '/repo',
        messageID: 'msg_2',
        agent: 'build',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
        command: 'ls',
      });
      await client.session.update({ sessionID: 'ses_1', directory: '/repo', time: { archived: 123 } });
      await client.permission.reply({ requestID: 'perm_1', directory: '/repo', reply: 'once' });
      await client.question.reply({ requestID: 'q_1', directory: '/repo', answers: [['yes']] });
      await client.auth.set({ providerID: 'anthropic', auth: { type: 'api', key: 'secret' } });
      await client.provider.oauth.callback({ providerID: 'github-copilot', method: 0, code: 'oauth-code' });

      expect(calls.map((call) => call.url)).toEqual([
        'https://app.example/api/session/ses_1/revert?directory=%2Frepo',
        'https://app.example/api/session/ses_1/shell?directory=%2Frepo',
        'https://app.example/api/session/ses_1?directory=%2Frepo',
        'https://app.example/api/permission/perm_1/reply?directory=%2Frepo',
        'https://app.example/api/question/q_1/reply?directory=%2Frepo',
        'https://app.example/api/auth/anthropic',
        'https://app.example/api/provider/github-copilot/oauth/callback',
      ]);
      expect(calls.map((call) => call.method)).toEqual(['POST', 'POST', 'PATCH', 'POST', 'POST', 'PUT', 'POST']);
      expect(calls.map((call) => call.headers.get('content-type'))).toEqual([
        'application/json',
        'application/json',
        'application/json',
        'application/json',
        'application/json',
        'application/json',
        'application/json',
      ]);
      expect(calls.map((call) => JSON.parse(call.body))).toEqual([
        { messageID: 'msg_1' },
        {
          messageID: 'msg_2',
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet' },
          command: 'ls',
        },
        { time: { archived: 123 } },
        { reply: 'once' },
        { answers: [['yes']] },
        { type: 'api', key: 'secret' },
        { method: 0, code: 'oauth-code' },
      ]);
    } finally {
      setRuntimeUrlResolver(previous);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('preserves SDK-style Request method, JSON body, signal, path, query, and merges auth headers', async () => {
    const previous = getRuntimeUrlResolver();
    const originalWindow = globalThis.window;
    const controller = new AbortController();
    const calls: Array<{ input: Request; body: string }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example/base' });
      setRuntimeBearerToken('runtime-token');
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: { location: { origin: 'https://app.example', href: 'https://app.example/app' } },
      });

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        calls.push({ input: request, body: await request.clone().text() });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch;

      const request = new Request('https://app.example/api/session/abc/prompt_async?directory=%2Frepo&workspace=main', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sdk-header': 'kept',
        },
        body: JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }),
        signal: controller.signal,
      });

      await runtimeFetch(request, { headers: { 'x-init-header': 'merged' } });

      expect(calls).toHaveLength(1);
      const captured = calls[0].input;
      expect(captured.url).toBe('https://runtime.example/api/session/abc/prompt_async?directory=%2Frepo&workspace=main');
      expect(captured.method).toBe('POST');
      expect(captured.signal).toBe(controller.signal);
      expect(captured.headers.get('content-type')).toBe('application/json');
      expect(captured.headers.get('x-sdk-header')).toBe('kept');
      expect(captured.headers.get('x-init-header')).toBe('merged');
      expect(captured.headers.get('authorization')).toBe('Bearer runtime-token');
      expect(calls[0].body).toBe(JSON.stringify({ parts: [{ type: 'text', text: 'hello' }] }));
    } finally {
      setRuntimeUrlResolver(previous);
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });

  test('does not replace an existing Authorization header', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      setRuntimeBearerToken('runtime-token');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      await runtimeFetch('/api/path', {
        headers: { Authorization: 'Bearer sdk-token' },
      });

      expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer sdk-token');
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('resolves URLSearchParams query and auth for runtime asset fetches', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      setRuntimeBearerToken('runtime-token');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(new Blob(['icon']), { status: 200 });
      }) as typeof fetch;

      await runtimeFetch('/api/projects/project-1/icon', {
        method: 'GET',
        headers: { Accept: 'image/*' },
        query: new URLSearchParams({ v: '123', theme: 'dark', iconColor: '#fff' }),
      });

      expect(String(calls[0].input)).toBe('https://runtime.example/api/projects/project-1/icon?v=123&theme=dark&iconColor=%23fff');
      const headers = new Headers(calls[0].init?.headers);
      expect(headers.get('accept')).toBe('image/*');
      expect(headers.get('authorization')).toBe('Bearer runtime-token');
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('does not attach runtime auth to non-runtime absolute URLs', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      setRuntimeBearerToken('runtime-token');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(null, { status: 204 });
      }) as typeof fetch;

      await runtimeFetch('https://old-runtime.example/api/config/settings');

      expect(String(calls[0].input)).toBe('https://old-runtime.example/api/config/settings');
      expect(new Headers(calls[0].init?.headers).has('authorization')).toBe(false);
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });

  test('attaches runtime auth to active runtime auth URLs', async () => {
    const previous = getRuntimeUrlResolver();
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];

    try {
      configureRuntimeUrlResolver({ apiBaseUrl: 'https://runtime.example' });
      setRuntimeBearerToken('runtime-token');

      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(JSON.stringify({ authenticated: true }), { status: 200 });
      }) as typeof fetch;

      await runtimeFetch('https://runtime.example/auth/session');

      expect(String(calls[0].input)).toBe('https://runtime.example/auth/session');
      expect(new Headers(calls[0].init?.headers).get('authorization')).toBe('Bearer runtime-token');
    } finally {
      setRuntimeUrlResolver(previous);
      globalThis.fetch = originalFetch;
      clearRuntimeAuthCredentialProvider();
    }
  });
});
