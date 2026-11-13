import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import { approveRootPasskey, createRootSpace, startRootSpace, type RootPasskeyDependencies } from './root-activation';
import { readRootPasskeys, type CreateSpaceRequest } from './spaces-api';
import { getRootStartConfirmation, settleRootStartConfirmation } from './root-start-confirmation';

const id = 'a1b2c3d4e5f6';
const origin = 'http://localhost:3000';
const assertion: AuthenticationResponseJSON = {
  id: 'approved', rawId: 'approved', type: 'public-key', clientExtensionResults: {},
  response: { authenticatorData: 'data', clientDataJSON: 'client', signature: 'signature' },
};
const options = {
  spaceId: id, challenge: 'challenge', rpID: 'localhost', expiresAt: 123456,
  allowCredentials: [{ id: 'approved', label: 'Security key', origin }, { id: 'other', label: 'Other address', origin: 'https://other.test' }],
};
const request: CreateSpaceRequest = {
  projectDirectory: '/project', name: 'Root work', placeId: 'host-root', start: 'clean',
  network: { mode: 'open', domains: [] }, setupCommands: [], grants: [],
};
const entry = {
  id, kind: 'host-root', placeId: 'host-root', name: request.name, state: 'running',
  projectDirectory: '/project', directory: `/spaces/${id}/project`, step: null, failure: null,
  network: request.network, grants: [], access: null, needsAccess: [],
};
const fetch = spyOn(globalThis, 'fetch');
let currentOrigin = origin;
const passkeys: RootPasskeyDependencies = { authenticate: async () => assertion, origin: () => currentOrigin };
const authentication = spyOn(passkeys, 'authenticate');
let calls: string[] = [];
let bodies: unknown[] = [];
beforeEach(() => {
  currentOrigin = origin;
  calls = [];
  bodies = [];
  authentication.mockImplementation(async () => { calls.push('passkey'); return assertion; });
  fetch.mockImplementation(async (input, init) => {
    const path = new URL(String(input), origin).pathname;
    calls.push(path);
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    return Response.json(path.endsWith('root-activation') ? options : entry);
  });
});
afterEach(() => { settleRootStartConfirmation(false); fetch.mockReset(); authentication.mockReset(); });

describe('root confirmation', () => {
  it('refuses an unapproved origin before requesting a challenge or starting WebAuthn', async () => {
    // Given
    currentOrigin = 'https://unapproved.test';
    // When / Then
    await expect(createRootSpace(request, [origin], passkeys)).rejects.toMatchObject({ code: 'root_activation_origin', message: origin });
    expect(calls).toEqual([]);
  });

  it('creates only after the challenge and a required-verification assertion for this origin', async () => {
    // Given / When
    await createRootSpace(request, [origin], passkeys);
    // Then
    expect(calls).toEqual(['/api/openchamber/spaces/root-activation', 'passkey', '/api/openchamber/spaces']);
    expect(bodies).toEqual([{ op: 'create', request }, { ...request, spaceId: id, rootActivation: assertion }]);
    expect(authentication).toHaveBeenCalledWith({ optionsJSON: {
      challenge: 'challenge', rpId: 'localhost', userVerification: 'required', allowCredentials: [{ id: 'approved', type: 'public-key' }],
    } });
  });

  it.each(['start', 'restart'] as const)('confirms before %s and sends the assertion to that action', async (action) => {
    // Given / When
    const result = startRootSpace(id, action, passkeys);
    expect(getRootStartConfirmation()).toEqual({ spaceId: id });
    expect(calls).toEqual([]);
    settleRootStartConfirmation(true);
    await result;
    // Then
    expect(calls).toEqual([`/api/openchamber/spaces/${id}/root-activation`, 'passkey', `/api/openchamber/spaces/${id}/${action}`]);
    expect(bodies).toEqual([{ op: 'start' }, { rootActivation: assertion }]);
  });

  it.each(['start', 'restart'] as const)('requests no challenge when the %s warning is cancelled', async (action) => {
    // Given
    const result = startRootSpace(id, action, passkeys);
    // When
    settleRootStartConfirmation(false);
    // Then
    await expect(result).rejects.toMatchObject({ code: 'root_activation_cancelled' });
    expect(calls).toEqual([]);
    expect(authentication).not.toHaveBeenCalled();
    expect(getRootStartConfirmation()).toBeNull();
  });

  it('creates nothing and never retries when the person cancels the native ceremony', async () => {
    // Given
    authentication.mockRejectedValue(new DOMException('Cancelled', 'NotAllowedError'));
    // When / Then
    await expect(createRootSpace(request, [origin], passkeys)).rejects.toMatchObject({ code: 'root_activation_cancelled' });
    expect(calls).toEqual(['/api/openchamber/spaces/root-activation']);
  });

  it('refuses the start challenge before WebAuthn when all credentials belong to another origin', async () => {
    // Given
    currentOrigin = 'https://unapproved.test';
    // When / Then
    const result = startRootSpace(id, 'start', passkeys);
    settleRootStartConfirmation(true);
    await expect(result).rejects.toMatchObject({ code: 'root_activation_origin' });
    expect(authentication).not.toHaveBeenCalled();
    expect(calls).toEqual([`/api/openchamber/spaces/${id}/root-activation`]);
  });

  it('preserves the server code on a refused challenge and runs no ceremony', async () => {
    // Given
    fetch.mockResolvedValue(Response.json({ code: 'root_passkey_not_approved', message: 'Refused' }, { status: 409 }));
    // When / Then
    const result = startRootSpace(id, 'start', passkeys);
    settleRootStartConfirmation(true);
    await expect(result).rejects.toMatchObject({ code: 'root_passkey_not_approved', status: 409 });
    expect(authentication).not.toHaveBeenCalled();
  });

  it('approves only an existing allowed sign-in passkey and leaves terminal confirmation pending', async () => {
    // Given
    const pending = { awaitingConfirmation: true, fingerprint: 'ABCD EFGH', label: 'My key', origin };
    fetch.mockResolvedValueOnce(Response.json({ challenge: 'approve', rpID: 'localhost', allowCredentials: [{ id: 'sign-in', label: 'My key' }] }))
      .mockResolvedValueOnce(Response.json(pending));
    // When
    const result = await approveRootPasskey('ABCD-EFGH', ' My key ', passkeys);
    // Then
    expect(result).toEqual(pending);
    expect(fetch.mock.calls.map(([path]) => String(path))).toEqual([
      '/api/openchamber/spaces/root-passkeys/approval-challenge', '/api/openchamber/spaces/root-passkeys/approval',
    ]);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ code: 'ABCD-EFGH', response: assertion, label: 'My key' }));
    expect(authentication).toHaveBeenCalledWith({ optionsJSON: {
      challenge: 'approve', rpId: 'localhost', userVerification: 'required', allowCredentials: [{ id: 'sign-in', type: 'public-key' }],
    } });
  });

  it('reads approved passkeys without mistaking a malformed response for an empty list', async () => {
    // Given
    fetch.mockResolvedValue(Response.json({ available: false, reason: 'no_passkey_approved' }));
    // When / Then
    await expect(readRootPasskeys()).rejects.toMatchObject({ code: 'space_answer_malformed' });
  });

  it('omits a blank optional label from the approval request', async () => {
    // Given
    fetch.mockResolvedValueOnce(Response.json({ challenge: 'approve', rpID: 'localhost', allowCredentials: [{ id: 'sign-in', label: 'My key' }] }))
      .mockResolvedValueOnce(Response.json({ awaitingConfirmation: true, fingerprint: 'ABCD EFGH', label: 'My key', origin }));
    // When
    await approveRootPasskey('ABCD-EFGH', '   ', passkeys);
    // Then
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ code: 'ABCD-EFGH', response: assertion }));
  });
});
