import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeFetchMock = vi.fn();

vi.mock('@openchamber/ui/lib/runtime-fetch', () => ({ runtimeFetch: runtimeFetchMock }));

const pairingResponse = () => Response.json({
  pairing: { id: 'pair', secret: 'one-time' },
  server: { label: 'Host', candidates: [] },
});

describe('createWebClientAuthAPI', () => {
  beforeEach(() => runtimeFetchMock.mockReset());

  it('omits direct E2EE by default without changing existing transport fields', async () => {
    runtimeFetchMock.mockResolvedValue(pairingResponse());
    const { createWebClientAuthAPI } = await import('./clientAuth');
    await createWebClientAuthAPI().createPairingSession({ includeDirect: false, includeRelay: true });
    const init = runtimeFetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ label: '', includeRelay: true, includeDirect: false });
  });

  it('forwards includeDirectE2ee only when explicitly requested and preserves body semantics', async () => {
    runtimeFetchMock.mockResolvedValue(pairingResponse());
    const { createWebClientAuthAPI } = await import('./clientAuth');
    await createWebClientAuthAPI().createPairingSession({
      label: 'Phone',
      allowedClientKinds: ['mobile'],
      serverUrl: 'https://lan.example',
      includeDirect: true,
      includeRelay: false,
      includeDirectE2ee: true,
    });
    const [path, init] = runtimeFetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/api/client-auth/pairing/sessions');
    expect(JSON.parse(String(init.body))).toEqual({
      label: 'Phone',
      allowedClientKinds: ['mobile'],
      serverUrl: 'https://lan.example',
      includeRelay: false,
      includeDirect: true,
      includeDirectE2ee: true,
    });
  });

  it('forwards an explicit false independently', async () => {
    runtimeFetchMock.mockResolvedValue(pairingResponse());
    const { createWebClientAuthAPI } = await import('./clientAuth');
    await createWebClientAuthAPI().createPairingSession({ includeDirectE2ee: false });
    const init = runtimeFetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ label: '', includeDirectE2ee: false });
  });

  it('throws on HTTP and malformed-response failures', async () => {
    const { createWebClientAuthAPI } = await import('./clientAuth');
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ error: 'denied' }, { status: 403 }));
    await expect(createWebClientAuthAPI().createPairingSession()).rejects.toThrow('denied');
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ pairing: {} }));
    await expect(createWebClientAuthAPI().createPairingSession()).rejects.toThrow('Failed to create pairing session');
  });
});
