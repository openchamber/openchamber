import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import { afterEach, describe, expect, it } from 'vitest';

import { SpaceError } from '../spaces/errors.js';
import { createRootPasskeys } from './passkey.js';
import { createRootOps } from './root-ops.js';
import { createState } from './state.js';
import { parseRequest } from './validation.js';
import { authenticator } from './test-support/software-authenticator.js';

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const ORIGIN = 'https://chamber.example.com';
const RP_ID = 'chamber.example.com';
const SEPARATED = { owner: 'dev', separation: { frontDoor: 'openchamber', agent: 'dev-agent', agentPort: 41890 } };
const SPEC = { id: 'a1b2c3d4e5f6', name: 'Root work', project: '0123456789abcdef', memoryBytes: 4 * 1024 ** 3 };

/**
 * hostd's state over a temporary directory, the system's accounts as `getent` answers them, and
 * the real passkey store. The test's own account plays the human, so a project it made can be shared.
 */
async function setup({ config = SEPARATED, accounts = {}, groups = {} } = {}) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hostd-root-ops-')));
  cleanups.push(() => fs.rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home', 'dev');
  const known = {
    dev: [process.getuid(), process.getgid(), home],
    openchamber: [2_000_000_001, 2_000_000_001, '/var/lib/openchamber'],
    'dev-agent': [2_000_000_002, 2_000_000_002, '/home/dev-agent'],
    ...accounts,
  };
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    if (file === '/usr/bin/getent') {
      const entry = known[args[1]];
      return entry ? { code: 0, stdout: `${args[1]}:x:${entry[0]}:${entry[1]}::${entry[2]}:/bin/bash\n`, stderr: '' } : { code: 2, stdout: '', stderr: '' };
    }
    if (file === '/usr/bin/id') return { code: 0, stdout: `${args[2]} ${(groups[args[2]] ?? []).join(' ')}\n`, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const paths = { state: path.join(base, 'state'), metadata: path.join(base, 'state', 'spaces'), tools: path.join(base, 'state', 'tools'), pins: path.join(base, 'run', 'ns') };
  const state = createState(paths);
  await state.initialize();
  const configFile = path.join(base, 'host.json');
  const writeConfig = (value) => fs.writeFile(configFile, JSON.stringify(value));
  await writeConfig(config);
  const passkeys = createRootPasskeys({ stateFile: path.join(paths.state, 'root-passkeys.json'), pendingFile: path.join(paths.state, 'approval.json'), verify: verifyAuthenticationResponse });
  const ops = createRootOps({ paths, state, run, configFile, passkeys, readMountInfo: async () => '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw\n' });
  return { base, home, calls, state, passkeys, ops, writeConfig };
}

/** A whole approval: the proof through hostd's operations, then the confirmation on the root terminal. */
async function approve({ ops, passkeys }, device) {
  const { code } = await passkeys.beginApproval();
  const { challenge } = await ops.handle(parseRequest({ op: 'root-approval-challenge', code }));
  const proved = await ops.handle(parseRequest({ op: 'root-approval-complete', code, credential: device.credential, response: device.assert(challenge, ORIGIN), label: 'Laptop' }));
  expect(proved).toMatchObject({ awaitingConfirmation: true, origin: ORIGIN });
  return passkeys.confirmApproval({ fingerprint: proved.fingerprint });
}

const optionsFor = (ops, request) => ops.handle(parseRequest({ op: 'root-activation-options', ...request }));

describe('whether root spaces may run', () => {
  it('says why not until the accounts are apart and a passkey is approved', async () => {
    const context = await setup({ config: { owner: 'dev', separation: null } });
    expect(await context.ops.status()).toEqual({ available: false, reason: 'agent_separation_missing', passkeys: [] });
    await context.writeConfig(SEPARATED);
    expect(await context.ops.status()).toEqual({ available: false, reason: 'no_passkey_approved', passkeys: [] });
    const approved = await approve(context, authenticator(RP_ID));
    expect(await context.ops.status()).toEqual({ available: true, reason: null, passkeys: [approved] });
  });

  it.each(['openchamber', 'dev-agent'])('counts no separation while %s is in a group that is root by another name', async (name) => {
    // Given the three accounts apart, with one of the two services in docker.
    const context = await setup({ groups: { [name]: ['docker'] } });
    // When asked, then root spaces stay unavailable.
    expect((await context.ops.status()).reason).toBe('agent_separation_missing');
    expect(await context.ops.separation()).toBeNull();
  });

  it('counts the accounts apart only when each exists, none is root and no two are the same', async () => {
    for (const accounts of [
      { 'dev-agent': undefined },
      { 'dev-agent': [process.getuid(), process.getgid(), '/home/dev-agent'] },
      { openchamber: [0, 0, '/var/lib/openchamber'] },
      { openchamber: [2_000_000_002, 2_000_000_002, '/var/lib/openchamber'] },
    ]) {
      const { ops } = await setup({ accounts });
      expect(await ops.separation()).toBeNull();
      expect((await ops.status()).reason).toBe('agent_separation_missing');
    }
    const { ops } = await setup({ config: { owner: 'dev', separation: { frontDoor: 'openchamber', agent: '../root', agentPort: 1 } } });
    expect(await ops.separation()).toBeNull();
  });
});

describe('root activation', () => {
  it('activates a creation of exactly the spec the confirmation was asked for, once', async () => {
    const context = await setup();
    const device = authenticator(RP_ID);
    await approve(context, device);
    const options = await optionsFor(context.ops, { action: 'create', spec: SPEC });
    expect(options.credentials).toEqual([expect.objectContaining({ id: device.credential.id, origin: ORIGIN })]);
    const assertion = device.assert(options.challenge, ORIGIN);
    // The creation time is no part of what was confirmed.
    await expect(context.ops.authorize({ op: 'create', id: SPEC.id, spec: { ...SPEC, created: new Date().toISOString() }, assertion })).resolves.toBeUndefined();
    await expect(context.ops.authorize({ op: 'create', id: SPEC.id, spec: SPEC, assertion })).rejects.toMatchObject({ code: 'root_activation_challenge_unknown' });
    const renamed = await optionsFor(context.ops, { action: 'create', spec: SPEC });
    const error = await context.ops.authorize({ op: 'create', id: SPEC.id, spec: { ...SPEC, name: 'Other' }, assertion: device.assert(renamed.challenge, ORIGIN) }).catch((failure) => failure);
    expect(error).toBeInstanceOf(SpaceError);
    expect(error.code).toBe('root_activation_mismatch');
  });

  it('starts a recorded root space only with a confirmation made for that start', async () => {
    const context = await setup();
    const device = authenticator(RP_ID);
    await approve(context, device);
    const record = { ...SPEC, place: 'host-root', created: new Date().toISOString(), subnet: 0, toolsKey: '0123456789abcdef' };
    await context.state.save(record);
    await expect(context.ops.authorize({ op: 'start', id: SPEC.id, spec: record, assertion: null })).rejects.toMatchObject({ code: 'root_activation_required' });
    // A confirmation for a creation of the same space does not start it.
    const created = await optionsFor(context.ops, { action: 'create', spec: { ...SPEC, id: 'b1b2c3d4e5f6' } });
    await expect(context.ops.authorize({ op: 'start', id: SPEC.id, spec: record, assertion: device.assert(created.challenge, ORIGIN) })).rejects.toMatchObject({ code: 'root_activation_mismatch' });
    const options = await optionsFor(context.ops, { action: 'start', id: SPEC.id });
    await expect(context.ops.authorize({ op: 'start', id: SPEC.id, spec: record, assertion: device.assert(options.challenge, ORIGIN) })).resolves.toBeUndefined();
    // A space hostd has no root record of has nothing to start.
    await expect(optionsFor(context.ops, { action: 'start', id: 'c1b2c3d4e5f6' })).rejects.toMatchObject({ code: 'space_not_found' });
  });

  it('refuses every activation while the accounts are not apart, a valid assertion included', async () => {
    const context = await setup();
    const device = authenticator(RP_ID);
    await approve(context, device);
    const options = await optionsFor(context.ops, { action: 'create', spec: SPEC });
    await context.writeConfig({ owner: 'dev', separation: null });
    await expect(context.ops.authorize({ op: 'create', id: SPEC.id, spec: SPEC, assertion: device.assert(options.challenge, ORIGIN) })).rejects.toMatchObject({ code: 'agent_separation_missing' });
    await expect(optionsFor(context.ops, { action: 'create', spec: SPEC })).rejects.toMatchObject({ code: 'agent_separation_missing' });
  });

  it('never activates an approval worker as root, nor a space id already in use', async () => {
    const context = await setup();
    await approve(context, authenticator(RP_ID));
    await expect(optionsFor(context.ops, { action: 'create', spec: { ...SPEC, purpose: 'pr-fix-loop-approval' } })).rejects.toMatchObject({ code: 'root_place_not_allowed' });
    await context.state.save({ ...SPEC, place: 'host', created: new Date().toISOString() });
    await expect(optionsFor(context.ops, { action: 'create', spec: SPEC })).rejects.toMatchObject({ code: 'space_name_taken' });
  });
});

describe('project sharing through hostd', () => {
  it('shares with the agent account the separation names, and refuses without the separation', async () => {
    const context = await setup({ config: { owner: 'dev', separation: null } });
    const project = path.join(context.home, 'workspace', 'app');
    await fs.mkdir(project, { recursive: true });
    await fs.chmod(path.join(context.base, 'home'), 0o755);
    await expect(context.ops.handle(parseRequest({ op: 'share-project', path: project }))).rejects.toMatchObject({ code: 'agent_separation_missing' });
    await context.writeConfig(SEPARATED);
    expect(await context.ops.handle(parseRequest({ op: 'project-owner', path: project }))).toEqual({ owner: 'human' });
    expect(await context.ops.handle(parseRequest({ op: 'share-project', path: project }))).toMatchObject({ path: project, status: 'shared' });
    expect(context.calls.filter(([file]) => file === '/usr/bin/setfacl').flat().join(' ')).toContain('u:dev-agent:rwX');
    expect(await context.ops.handle(parseRequest({ op: 'project-shares' }))).toEqual([expect.objectContaining({ path: project })]);
  });
});

describe('the requests of these operations', () => {
  const assertion = authenticator(RP_ID).assert('challenge', ORIGIN);

  it('takes only the fields each operation has', () => {
    expect(() => parseRequest({ op: 'root-shell' })).toThrow(SpaceError);
    expect(parseRequest({ op: 'root-status' })).toEqual({ op: 'root-status' });
    expect(() => parseRequest({ op: 'root-status', place: 'host-root' })).toThrow(SpaceError);
    expect(() => parseRequest({ op: 'root-activation-options', action: 'stop', id: SPEC.id })).toThrow(SpaceError);
    expect(() => parseRequest({ op: 'root-activation-options', action: 'create', spec: { ...SPEC, created: '2026-01-01T00:00:00.000Z' } })).toThrow(SpaceError);
    expect(() => parseRequest({ op: 'root-activation-options', action: 'start', id: SPEC.id, spec: SPEC })).toThrow(SpaceError);
    expect(() => parseRequest({ op: 'share-project', path: 'workspace/app' })).toThrow(SpaceError);
    expect(() => parseRequest({ op: 'share-project', path: '/home/dev/../root' })).toThrow(SpaceError);
  });

  it('takes an assertion only in the shape a browser makes it', () => {
    const complete = (response) => parseRequest({ op: 'root-approval-complete', code: 'ABCD-EFGH', credential: { id: 'x', publicKey: 'y', rpID: RP_ID }, response });
    expect(complete(assertion).response).toEqual(assertion);
    expect(() => complete({ ...assertion, type: 'password' })).toThrow(SpaceError);
    expect(() => complete({ ...assertion, extra: true })).toThrow(SpaceError);
    expect(() => complete({ ...assertion, response: { ...assertion.response, signature: 'not base64url!' } })).toThrow(SpaceError);
    expect(() => complete({ ...assertion, clientExtensionResults: { padding: 'x'.repeat(5000) } })).toThrow(SpaceError);
  });

  it('takes an assertion on the create and start of a root space only', () => {
    const create = { op: 'create', spec: { ...SPEC, created: '2026-11-06T00:00:00.000Z' }, toolsKey: '0123456789abcdef' };
    expect(parseRequest({ ...create, place: 'host-root', assertion }).assertion).toEqual(assertion);
    expect(parseRequest({ op: 'start', place: 'host-root', id: SPEC.id, assertion }).assertion).toEqual(assertion);
    expect(parseRequest({ op: 'start', place: 'host-root', id: SPEC.id })).not.toHaveProperty('assertion');
    expect(() => parseRequest({ ...create, place: 'host', assertion })).toThrow(SpaceError);
    expect(() => parseRequest({ op: 'start', place: 'host', id: SPEC.id, assertion })).toThrow(SpaceError);
    expect(() => parseRequest({ op: 'stop', place: 'host-root', id: SPEC.id, assertion })).toThrow(SpaceError);
  });
});
