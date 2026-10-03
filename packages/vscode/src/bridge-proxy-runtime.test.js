import { describe, expect, it, mock } from 'bun:test';

const { handleProxyBridgeMessage } = await import('./bridge-proxy-runtime');

const createDeps = () => ({
  tryHandleLocalFsProxy: mock(() => Promise.resolve(null)),
  buildUnavailableApiResponse: mock(() => ({ status: 503, headers: {}, bodyText: '' })),
  sanitizeForwardHeaders: mock((headers) => headers || {}),
  collectHeaders: mock(() => ({})),
  base64EncodeUtf8: mock((text) => Buffer.from(text, 'utf8').toString('base64')),
});

describe('bridge proxy runtime', () => {
  it('does not buffer SSE endpoints through the generic API proxy', async () => {
    const deps = createDeps();

    const response = await handleProxyBridgeMessage(
      { id: '1', type: 'api:proxy', payload: { method: 'GET', path: '/api/event?lastEventId=evt-1' } },
      undefined,
      deps,
    );

    expect(response?.success).toBe(true);
    expect(response?.data).toMatchObject({
      status: 400,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({ error: 'SSE requests must use api:sse:start' }),
    });
    expect(deps.tryHandleLocalFsProxy).not.toHaveBeenCalled();
    expect(deps.buildUnavailableApiResponse).not.toHaveBeenCalled();
  });

  it('never hands the stored credential list to the webview', async () => {
    for (const path of ['/api/credential', '/API//%63redential/', '/http:api/credential', 'HTTP:/api/credential', '/api/x/../credential']) {
      const response = await handleProxyBridgeMessage(
        { id: '1', type: 'api:proxy', payload: { method: 'GET', path } },
        undefined,
        createDeps(),
      );
      expect(response?.data).toMatchObject({ status: 403 });
      expect(JSON.parse(response?.data.bodyText).code).toBe('credential_list_refused');
    }
  });

  it('refuses a path that would resolve outside OpenCode', async () => {
    for (const path of ['/http://127.0.0.1:4096/api/session', '/https:api/session', '/http://evil.test/api/session']) {
      const response = await handleProxyBridgeMessage(
        { id: '1', type: 'api:proxy', payload: { method: 'GET', path } },
        undefined,
        createDeps(),
      );
      expect(response?.data).toMatchObject({ status: 400 });
    }
  });

  it('in enterprise mode refuses connecting a provider but forwards an MCP server sign-in', async () => {
    const proxy = (path) => handleProxyBridgeMessage(
      { id: '1', type: 'api:proxy', payload: { method: 'POST', path } },
      undefined,
      createDeps(),
    );
    const previous = process.env.OPENCHAMBER_ENTERPRISE_MODE;
    process.env.OPENCHAMBER_ENTERPRISE_MODE = '1';
    try {
      for (const path of ['/api/integration/openai/connect/key', '/API//integration/openai/%63onnect/key', '/api/credential', '/http:api/integration/openai/connect/key', '/http:api/credential']) {
        const response = await proxy(path);
        expect(response?.data).toMatchObject({ status: 403 });
        expect(JSON.parse(response?.data.bodyText).code).toBe('enterprise_mode');
      }
      // No OpenCode behind this bridge: a forwarded request reads as unavailable.
      const signIn = await proxy('/api/integration/mcp_0123456789abcdef/connect/oauth');
      expect(signIn?.data).toMatchObject({ status: 503 });
    } finally {
      if (previous === undefined) delete process.env.OPENCHAMBER_ENTERPRISE_MODE;
      else process.env.OPENCHAMBER_ENTERPRISE_MODE = previous;
    }
  });
});
