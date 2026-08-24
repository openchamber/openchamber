import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUiPasskeys } from './ui-passkeys.js';

const request = { headers: { host: 'localhost:3000' }, socket: {} };

const createController = (challengeTtlMs = 60_000) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-passkey-reauth-'));
  const storeFile = path.join(directory, 'passkeys.json');
  fs.writeFileSync(storeFile, JSON.stringify({
    version: 1,
    userID: Buffer.from('user').toString('base64url'),
    passwordBinding: 'binding',
    passkeys: [{
      id: 'credential-1', publicKey: Buffer.from('key').toString('base64url'), counter: 0,
      transports: [], deviceType: 'singleDevice', backedUp: false, createdAt: Date.now(),
      lastUsedAt: null, label: 'Test', rpID: 'localhost',
    }],
  }));
  return createUiPasskeys({
    passwordBinding: 'binding', storeFile, challengeTtlMs,
    generateAuthenticationOptionsFn: vi.fn(async () => ({ challenge: 'challenge', allowCredentials: [] })),
    verifyAuthenticationResponseFn: vi.fn(async () => ({ verified: true, authenticationInfo: { newCounter: 1 } })),
  });
};

describe('operation-bound passkey challenges', () => {
  it('returns the server-stored binding once and rejects replay', async () => {
    const controller = createController();
    const binding = { principal: 'client:a', operation: 'host.capabilities', project: 'host', bodyHash: 'a'.repeat(64), nonce: 'nonce-1234567890abcdef' };
    const options = await controller.beginAuthentication(request, { binding });
    const payload = { requestId: options.requestId, response: { id: 'credential-1' } };
    await expect(controller.finishAuthentication(payload)).resolves.toMatchObject({ verified: true, binding });
    await expect(controller.finishAuthentication(payload)).rejects.toThrow(/expired/);
  });

  it('rejects expired challenges without accepting a replacement binding', async () => {
    const controller = createController(1);
    const binding = { principal: 'client:a', operation: 'workspace.export', project: '/repo', bodyHash: 'b'.repeat(64), nonce: 'nonce-1234567890abcdef' };
    const options = await controller.beginAuthentication(request, { binding });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(controller.finishAuthentication({ requestId: options.requestId, response: { id: 'credential-1' }, binding: { ...binding, project: '/other' } })).rejects.toThrow(/expired/);
  });
});
