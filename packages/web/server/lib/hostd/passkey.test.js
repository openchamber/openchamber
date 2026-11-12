import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { afterEach, describe, expect, it } from 'vitest';

import { activationSpecHash, createRootPasskeys, passkeyFingerprint } from './passkey.js';
import { authenticator } from './test-support/software-authenticator.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup({ now = () => Date.now() } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-passkey-'));
  cleanups.push(() => fs.rm(directory, { recursive: true, force: true }));
  const passkeys = createRootPasskeys({ stateFile: path.join(directory, 'passkeys.json'), pendingFile: path.join(directory, 'approval.json'), verify: verifyAuthenticationResponse, now });
  return { directory, passkeys };
}

const ORIGIN = 'https://chamber.example.com';
const RP_ID = 'chamber.example.com';
const SPACE = 'a1b2c3d4e5f6';
const SPEC_HASH = activationSpecHash({ place: 'host-root', id: SPACE, name: 'Root work', project: 'p'.repeat(64), memoryBytes: 1024 });

/** The proof half of an approval: what OpenChamber does with the code the root command printed. */
async function prove(passkeys, device, { origin = ORIGIN, label = 'Laptop' } = {}) {
  const { code } = await passkeys.beginApproval();
  const { challenge } = await passkeys.approvalChallenge({ code });
  return { code, proved: await passkeys.completeApproval({ code, credential: device.credential, response: device.assert(challenge, origin), label }) };
}

/** A whole approval: the proof in OpenChamber, then the confirmation on the root terminal. */
async function approve(passkeys, device, options) {
  const { proved } = await prove(passkeys, device, options);
  return passkeys.confirmApproval({ fingerprint: proved.fingerprint });
}

describe('root passkey approval', () => {
  it('approves a passkey after the proof in OpenChamber and the confirmation on the root terminal', async () => {
    const { passkeys } = await setup();
    const device = authenticator(RP_ID);
    const { proved } = await prove(passkeys, device);
    const fingerprint = passkeyFingerprint(device.credential);
    expect(proved).toEqual({ awaitingConfirmation: true, fingerprint, label: 'Laptop', origin: ORIGIN });
    // Proved is not approved: the root terminal sees it and nothing can activate yet.
    expect(await passkeys.list()).toEqual([]);
    expect(await passkeys.pendingCandidate()).toEqual({ id: device.credential.id, label: 'Laptop', rpID: RP_ID, origin: ORIGIN, fingerprint });
    await expect(passkeys.activationOptions({ op: 'create', id: SPACE, specHash: SPEC_HASH })).rejects.toMatchObject({ code: 'root_passkey_not_approved' });
    expect(await passkeys.confirmApproval({ fingerprint })).toMatchObject({ id: device.credential.id, origin: ORIGIN, fingerprint });
    expect(await passkeys.list()).toEqual([expect.objectContaining({ id: device.credential.id, origin: ORIGIN })]);
    expect(await passkeys.pendingCandidate()).toBeNull();
  });

  it('does not confirm a passkey other than the one the root terminal showed', async () => {
    const { passkeys } = await setup();
    await prove(passkeys, authenticator(RP_ID));
    await expect(passkeys.confirmApproval({ fingerprint: '0000-0000-0000-0000' })).rejects.toMatchObject({ code: 'approval_fingerprint_changed' });
    expect(await passkeys.list()).toEqual([]);
  });

  it('refuses a second proof while a passkey waits for confirmation', async () => {
    const { passkeys } = await setup();
    const { code } = await prove(passkeys, authenticator(RP_ID));
    await expect(passkeys.approvalChallenge({ code })).rejects.toMatchObject({ code: 'approval_awaiting_confirmation' });
  });

  it('refuses an approval without the root code, with a wrong code, and drops the approval after five wrong codes', async () => {
    const { passkeys, directory } = await setup();
    await expect(passkeys.approvalChallenge({ code: 'ABCD-EFGH' })).rejects.toMatchObject({ code: 'approval_not_started' });
    const { code } = await passkeys.beginApproval();
    const wrong = code.startsWith('A') ? 'BBBB-BBBB' : 'AAAA-AAAA';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(passkeys.approvalChallenge({ code: wrong })).rejects.toMatchObject({ code: 'approval_code_wrong' });
    }
    await expect(fs.stat(path.join(directory, 'approval.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(passkeys.approvalChallenge({ code })).rejects.toMatchObject({ code: 'approval_not_started' });
  });

  it('refuses an expired approval code', async () => {
    let clock = 1_000_000;
    const { passkeys } = await setup({ now: () => clock });
    const { code } = await passkeys.beginApproval();
    clock += 10 * 60_000 + 1;
    await expect(passkeys.approvalChallenge({ code })).rejects.toMatchObject({ code: 'approval_expired' });
  });

  it('refuses to approve at an origin that is not secure or not under the passkey\'s RP ID', async () => {
    for (const origin of ['http://chamber.example.com', 'https://evil.example.net', 'https://example.com', 'https://chamber.example.com.evil.net']) {
      const { passkeys } = await setup();
      const device = authenticator(RP_ID);
      const { code } = await passkeys.beginApproval();
      const { challenge } = await passkeys.approvalChallenge({ code });
      await expect(passkeys.completeApproval({ code, credential: device.credential, response: device.assert(challenge, origin) }), origin).rejects.toMatchObject({ code: 'approval_origin_refused' });
      expect(await passkeys.pendingCandidate()).toBeNull();
    }
  });

  it('refuses a proof whose assertion does not verify, and drops the approval', async () => {
    const { passkeys } = await setup();
    const device = authenticator(RP_ID);
    const other = authenticator(RP_ID);
    const { code } = await passkeys.beginApproval();
    const { challenge } = await passkeys.approvalChallenge({ code });
    // The record names one key, and the assertion is signed by another with the same id.
    const forged = other.assert(challenge, ORIGIN, { credentialId: device.credential.id });
    await expect(passkeys.completeApproval({ code, credential: device.credential, response: forged })).rejects.toMatchObject({ code: 'approval_assertion_refused' });
    expect(await passkeys.pendingCandidate()).toBeNull();
    await expect(passkeys.approvalChallenge({ code })).rejects.toMatchObject({ code: 'approval_not_started' });
  });

  it('requires user verification for a proof', async () => {
    const { passkeys } = await setup();
    const device = authenticator(RP_ID);
    const { code } = await passkeys.beginApproval();
    const { challenge } = await passkeys.approvalChallenge({ code });
    await expect(passkeys.completeApproval({ code, credential: device.credential, response: device.assert(challenge, ORIGIN, { userVerified: false }) })).rejects.toMatchObject({ code: 'approval_assertion_refused' });
  });

  it('keeps its files to root: the state and the pending approval are mode 0600', async () => {
    const { passkeys, directory } = await setup();
    const device = authenticator(RP_ID);
    const { code } = await passkeys.beginApproval();
    expect((await fs.stat(path.join(directory, 'approval.json'))).mode & 0o777).toBe(0o600);
    const { challenge } = await passkeys.approvalChallenge({ code });
    const proved = await passkeys.completeApproval({ code, credential: device.credential, response: device.assert(challenge, ORIGIN) });
    await passkeys.confirmApproval({ fingerprint: proved.fingerprint });
    expect((await fs.stat(path.join(directory, 'passkeys.json'))).mode & 0o777).toBe(0o600);
  });
});

describe('root activation', () => {
  it('activates with a fresh assertion for that operation, space and specification, once', async () => {
    const { passkeys } = await setup();
    const device = authenticator(RP_ID);
    await approve(passkeys, device);
    const { challenge, credentials } = await passkeys.activationOptions({ op: 'create', id: SPACE, specHash: SPEC_HASH });
    expect(credentials).toEqual([expect.objectContaining({ id: device.credential.id, origin: ORIGIN })]);
    const response = device.assert(challenge, ORIGIN);
    await expect(passkeys.verifyActivation({ op: 'create', id: SPACE, specHash: SPEC_HASH, response })).resolves.toEqual({ credential: device.credential.id });
    // The same assertion a second time: its challenge was consumed.
    await expect(passkeys.verifyActivation({ op: 'create', id: SPACE, specHash: SPEC_HASH, response })).rejects.toMatchObject({ code: 'root_activation_challenge_unknown' });
  });

  it('refuses an assertion made for another operation, another space or another specification, and consumes it', async () => {
    const { passkeys } = await setup();
    const device = authenticator(RP_ID);
    await approve(passkeys, device);
    const otherHash = activationSpecHash({ place: 'host-root', id: SPACE, name: 'Changed', project: 'p'.repeat(64), memoryBytes: 1024 });
    for (const asked of [{ op: 'start', id: SPACE, specHash: SPEC_HASH }, { op: 'create', id: 'ffffffffffff', specHash: SPEC_HASH }, { op: 'create', id: SPACE, specHash: otherHash }]) {
      const { challenge } = await passkeys.activationOptions({ op: 'create', id: SPACE, specHash: SPEC_HASH });
      const response = device.assert(challenge, ORIGIN);
      await expect(passkeys.verifyActivation({ ...asked, response }), JSON.stringify(asked)).rejects.toMatchObject({ code: 'root_activation_mismatch' });
      await expect(passkeys.verifyActivation({ op: 'create', id: SPACE, specHash: SPEC_HASH, response })).rejects.toMatchObject({ code: 'root_activation_challenge_unknown' });
    }
  });

  it('refuses an activation from any origin but the approved one, even under the same RP ID', async () => {
    const { passkeys } = await setup();
    const device = authenticator('example.com');
    await approve(passkeys, device, { origin: 'https://chamber.example.com' });
    const { challenge } = await passkeys.activationOptions({ op: 'start', id: SPACE, specHash: SPEC_HASH });
    const fromSibling = device.assert(challenge, 'https://evil.example.com');
    await expect(passkeys.verifyActivation({ op: 'start', id: SPACE, specHash: SPEC_HASH, response: fromSibling })).rejects.toMatchObject({ code: 'root_activation_refused' });
  });

  it('refuses a passkey that was never approved, and a revoked one', async () => {
    const { passkeys } = await setup();
    const device = authenticator(RP_ID);
    const stranger = authenticator(RP_ID);
    await approve(passkeys, device);
    const { challenge } = await passkeys.activationOptions({ op: 'start', id: SPACE, specHash: SPEC_HASH });
    await expect(passkeys.verifyActivation({ op: 'start', id: SPACE, specHash: SPEC_HASH, response: stranger.assert(challenge, ORIGIN) })).rejects.toMatchObject({ code: 'root_passkey_not_approved' });
    expect(await passkeys.revoke(device.credential.id)).toEqual({ removed: 1 });
    await expect(passkeys.activationOptions({ op: 'start', id: SPACE, specHash: SPEC_HASH })).rejects.toMatchObject({ code: 'root_passkey_not_approved' });
  });

  it('refuses an assertion whose counter did not grow, and keeps working for the next real one', async () => {
    const { passkeys } = await setup();
    const device = authenticator(RP_ID);
    await approve(passkeys, device);
    let { challenge } = await passkeys.activationOptions({ op: 'start', id: SPACE, specHash: SPEC_HASH });
    await passkeys.verifyActivation({ op: 'start', id: SPACE, specHash: SPEC_HASH, response: device.assert(challenge, ORIGIN) });
    ({ challenge } = await passkeys.activationOptions({ op: 'start', id: SPACE, specHash: SPEC_HASH }));
    const replayedCounter = device.assert(challenge, ORIGIN, { count: false });
    await expect(passkeys.verifyActivation({ op: 'start', id: SPACE, specHash: SPEC_HASH, response: replayedCounter })).rejects.toMatchObject({ code: 'root_activation_refused' });
    ({ challenge } = await passkeys.activationOptions({ op: 'start', id: SPACE, specHash: SPEC_HASH }));
    await expect(passkeys.verifyActivation({ op: 'start', id: SPACE, specHash: SPEC_HASH, response: device.assert(challenge, ORIGIN) })).resolves.toEqual({ credential: device.credential.id });
  });

  it('refuses an expired activation challenge', async () => {
    let clock = 5_000_000;
    const { passkeys } = await setup({ now: () => clock });
    const device = authenticator(RP_ID);
    await approve(passkeys, device);
    const { challenge } = await passkeys.activationOptions({ op: 'start', id: SPACE, specHash: SPEC_HASH });
    clock += 5 * 60_000 + 1;
    await expect(passkeys.verifyActivation({ op: 'start', id: SPACE, specHash: SPEC_HASH, response: device.assert(challenge, ORIGIN) })).rejects.toMatchObject({ code: 'root_activation_challenge_unknown' });
  });

  it('serializes writers across processes with a lock file and takes over a dead holder\'s lock', async () => {
    const { passkeys, directory } = await setup();
    // A lock left by a process that no longer exists does not block the root command.
    await fs.writeFile(path.join(directory, 'passkeys.json.lock'), '2147483646');
    await approve(passkeys, authenticator(RP_ID));
    expect(await passkeys.list()).toHaveLength(1);
    await expect(fs.stat(path.join(directory, 'passkeys.json.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
