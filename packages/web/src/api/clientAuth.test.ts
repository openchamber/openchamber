import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeFetch = vi.fn();
const requestReauthProof = vi.fn();
vi.mock('@openchamber/ui/lib/runtime-fetch', () => ({ runtimeFetch }));
vi.mock('./reauth', () => ({ requestReauthProof }));

describe('web client authorization API', () => {
  beforeEach(() => {
    runtimeFetch.mockReset();
    requestReauthProof.mockReset();
  });

  it('sends capability proof headers with the exact grant and revoke body', async () => {
    runtimeFetch.mockResolvedValue(new Response(JSON.stringify({ updated: true, client: { id: 'client-1' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const { createWebClientAuthAPI } = await import('./clientAuth');
    await createWebClientAuthAPI().updateClientCapabilities('client-1', {
      grant: ['workspace.admin'],
      revoke: ['workspace.use'],
      reauthProof: 'proof',
      reauthNonce: 'nonce',
    });
    expect(runtimeFetch).toHaveBeenCalledWith('/api/host-admin/clients/client-1/capabilities', expect.objectContaining({
      method: 'PATCH',
      headers: expect.objectContaining({
        'X-OpenChamber-Reauth-Proof': 'proof',
        'X-OpenChamber-Reauth-Nonce': 'nonce',
      }),
      body: JSON.stringify({ grant: ['workspace.admin'], revoke: ['workspace.use'] }),
    }));
  });
});
