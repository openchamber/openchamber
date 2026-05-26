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
      { id: '1', type: 'api:proxy', payload: { method: 'GET', path: '/global/event?lastEventId=evt-1' } },
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
});
