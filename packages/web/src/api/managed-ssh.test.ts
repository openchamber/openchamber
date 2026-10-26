import { afterEach, describe, expect, it, vi } from 'vitest';
import { managedSshCredentials } from './managed-ssh';
import { configureRuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import { setRuntimeBearerToken } from '@openchamber/ui/lib/runtime-auth';

const unavailable = { status: 'unsupported', reason: 'host-setup-required' };
const credential = { credentialId: 'ocgit:v1:ssh:a2V5X29uZQ', label: 'SSH', fingerprint: `SHA256:${'a'.repeat(43)}`, capability: { status: 'ready' } };
const inventory = { status: 'available', credentials: [credential] };
const candidate = { candidateId: 'ssh_candidate_one', label: 'id_ed25519', fingerprint: credential.fingerprint, capability: { status: 'ready' } };
afterEach(() => { vi.restoreAllMocks(); configureRuntimeUrlResolver({ apiBaseUrl: '' }); setRuntimeBearerToken(null); });

describe('managed SSH web adapter', () => {
  it('parses opaque inventory, discovery, import and typed rejection results without importing automatically', async () => {
    const fetch = vi.fn(async () => Response.json(inventory));
    expect(await managedSshCredentials({ operation: 'inventory' }, fetch)).toEqual(inventory);
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/git/managed-ssh-credentials', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"operation":"inventory"}',
    });
    const discovered = { status: 'discovered', candidates: [candidate,
      { label: 'id_rsa', capability: { status: 'unavailable', reason: 'encrypted-or-unverifiable' } }], truncated: false };
    fetch.mockImplementationOnce(async () => Response.json(discovered));
    expect(await managedSshCredentials({ operation: 'discover' }, fetch)).toEqual(discovered);
    const imported = { status: 'imported', credentials: [credential], selectedCredential: credential };
    fetch.mockImplementationOnce(async () => Response.json(imported));
    expect(await managedSshCredentials({ operation: 'import', candidateId: candidate.candidateId,
      expectedFingerprint: candidate.fingerprint, confirmed: true }, fetch)).toEqual(imported);
    fetch.mockImplementationOnce(async () => Response.json({ status: 'rejected', reason: 'candidate-expired' }));
    expect(await managedSshCredentials({ operation: 'import', candidateId: 'old', expectedFingerprint: credential.fingerprint,
      confirmed: true }, fetch)).toEqual({ status: 'rejected', reason: 'candidate-expired' });
    fetch.mockImplementationOnce(async () => Response.json(unavailable));
    expect(await managedSshCredentials({ operation: 'discover' }, fetch)).toEqual(unavailable);
  });

  it('rejects paths, secrets, malformed metadata and HTTP failure instead of returning empty inventory', async () => {
    for (const value of [{ ...inventory, privateKeyPath: '/private/key' },
      { ...inventory, credentials: [{ ...credential, privateKey: 'secret' }] },
      { ...inventory, credentials: [{ ...credential, label: '/private/key' }] },
      { ...inventory, credentials: [{ ...credential, fingerprint: 'invalid' }] },
      { ...inventory, credentials: [{ ...credential, capability: { status: 'ready', secret: 'secret' } }] },
      { status: 'discovered', candidates: [{ ...candidate, privateKeyPath: '/private/key' }], truncated: false },
      { status: 'imported', credentials: [], selectedCredential: credential },
      { status: 'rejected', reason: 'unknown' }]) {
      await expect(managedSshCredentials({ operation: 'inventory' }, async () => Response.json(value))).rejects.toThrow();
    }
    await expect(managedSshCredentials({ operation: 'inventory' }, async () => Response.json({ credentials: [] }, { status: 500 }))).rejects.toThrow('request failed');
  });

  it('resolves the connected server and auth at call time after runtime switching', async () => {
    const requests: Request[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      requests.push(new Request(input, init));
      return Response.json(inventory);
    });
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://server-a.example.com' });
    setRuntimeBearerToken('fixture-a');
    await managedSshCredentials({ operation: 'inventory' });
    configureRuntimeUrlResolver({ apiBaseUrl: 'https://server-b.example.com' });
    setRuntimeBearerToken('fixture-b');
    await managedSshCredentials({ operation: 'inventory' });
    expect(requests.map((request) => request.url)).toEqual([
      'https://server-a.example.com/api/git/managed-ssh-credentials', 'https://server-b.example.com/api/git/managed-ssh-credentials',
    ]);
    expect(requests.map((request) => request.headers.get('Authorization'))).toEqual(['Bearer fixture-a', 'Bearer fixture-b']);
  });
});
