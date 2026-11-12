// The journey on this computer's own places: a root space made and started only with a passkey
// confirmation made for it, and protected MCP connections given to a space through its own
// subject of the protected MCP service, never to a Docker space. The places are memory places
// that say which kind they are and record what reached them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { createSpaceJourney } from './journey.js';
import { hashProjectDirectory } from './labels.js';
import { createSpaceManager } from './manager.js';
import { createMemoryPlace } from './places/memory-place.js';
import { createPlaceRegistry } from './places/registry.js';
import { createSpaceRecords } from './space-records.js';

const PROJECT = '/home/me/project';
const CONNECTION = 'pmcp_0123456789abcdef';
const ASSERTION = {
  id: 'Y3JlZGVudGlhbC1pZC0x',
  rawId: 'Y3JlZGVudGlhbC1pZC0x',
  type: 'public-key',
  response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA' },
  clientExtensionResults: {},
};
const quiet = { warn: () => {}, info: () => {} };
const folders = [];
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const until = async (check, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await sleep(5);
  return check();
};

afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

/** A memory place of this kind that records each create and start with what came with it. */
const placeOf = (id, kind, seen) => {
  const inner = createMemoryPlace({ id });
  const place = {
    ...inner,
    kind,
    check: async () => ({ ...(await inner.check()), hostIsolation: kind !== 'host-root' }),
    create: async (spec, options = {}) => { seen.push(['create', id, spec, options.activation ?? null]); return inner.create(spec, options); },
    start: async (spaceId, options = {}) => { seen.push(['start', id, spaceId, options.activation ?? null]); return inner.start(spaceId); },
    remove: async (spaceId) => { seen.push(['remove', id, spaceId]); return inner.remove(spaceId); },
  };
  if (kind !== 'host-root') return place;
  return {
    ...place,
    rootActivationOptions: async (request) => { seen.push(['options', id, request]); return { challenge: 'challenge', expiresAt: 1, credentials: [] }; },
    rootStatus: async () => { throw new SpaceError('hostd_missing', 'Install and enable the OpenChamber host daemon'); },
  };
};

/**
 * A journey over a Docker-like memory place, a host place and a root place. `subjects` answers
 * each change of the protected MCP service's subjects; `archiveChats` is the chat archive or null.
 */
const setup = ({ subjects = async () => ({ ok: true }), archiveChats = null } = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-journey-host-'));
  folders.push(dataDir);
  const seen = [];
  const events = [];
  const configs = [];
  const records = createSpaceRecords({ dataDir, logger: quiet });
  const places = createPlaceRegistry([placeOf('memory', undefined, seen), placeOf('host', 'host', seen), placeOf('host-root', 'host-root', seen)]);
  const manager = createSpaceManager({
    registry: places,
    locate: async (spaceId) => records.read(spaceId).record?.placeId ?? null,
    recall: async () => records.list().map(({ id, record }) => ({ placeId: record.placeId, id, name: record.name ?? id, project: hashProjectDirectory(record.repository), created: record.created ?? '' })),
  });
  const mcpSubjects = {
    set: async (subject, connections) => { seen.push(['subject-set', subject, connections]); return subjects('set', subject, connections); },
    remove: async (subject) => { seen.push(['subject-remove', subject]); return subjects('remove', subject); },
  };
  const journey = createSpaceJourney({
    manager,
    places,
    gatekeeper: {
      setNetwork: async () => {},
      addGrant: async () => {},
      readPolicy: async () => ({ mode: 'open', domains: [], grants: [] }),
      readJournal: async () => ({ records: [], dropped: 0, since: null }),
    },
    codeIn: {
      bringCodeIn: async ({ spaceId }) => ({ spacePath: `/spaces/${spaceId}/project`, projectPath: `/spaces/${spaceId}/project`, base: 'b'.repeat(40), identityCopied: { name: true, email: true } }),
      sendHistory: async () => ({ status: 'sent' }),
      removeSpaceRefs: async () => {},
    },
    codeOut: {},
    records,
    spaceOpenCode: {
      writeProviderConfig: async (spaceId, grants) => { configs.push([spaceId, grants]); },
      writeLogin: async () => {},
      removeLogin: async () => {},
    },
    serverInside: {
      writeToken: async () => {},
      writeIdleStop: async () => {},
      writePermissionDefault: async () => {},
      writeUserTaskTitle: async () => {},
      waitUntilReady: async () => {},
    },
    restartOpenCodeInside: async () => {},
    listProjectDirectories: async () => [PROJECT],
    mcpSubjects,
    archiveChats,
    folderExists: async () => true,
    announce: (spaceId, payload) => { events.push({ spaceId, ...payload.properties }); },
    logger: quiet,
  });
  return { journey, records, seen, events, configs };
};

const request = (placeId, extra = {}) => ({ projectDirectory: PROJECT, name: 'Work', placeId, start: 'clean', network: { mode: 'open', domains: [] }, ...extra });

/** Creates a space and waits until it is ready. */
const created = async ({ journey, events }, body) => {
  const entry = await journey.createSpace(body);
  expect(await until(() => events.some((event) => event.spaceId === entry.id && ['ready', 'failed'].includes(event.step)))).toBe(true);
  expect(events.find((event) => event.spaceId === entry.id && event.step === 'failed')).toBeUndefined();
  return entry.id;
};

/** A root space made with a confirmation, as the dialog does it: ask for the challenge, then create with it. */
const createdRoot = async (context) => {
  const { spaceId } = await context.journey.rootActivationOptions({ op: 'create', request: request('host-root', { name: '  Root   work ' }) });
  return created(context, request('host-root', { name: '  Root   work ', spaceId, rootActivation: ASSERTION }));
};

const refusal = async (promise) => {
  const error = await promise.then(() => null, (failure) => failure);
  expect(error).toBeInstanceOf(SpaceError);
  return error.code;
};

describe('a root space', () => {
  it('is created only under the id its confirmation was asked for, with that confirmation, for exactly the spec asked about', async () => {
    const context = setup();
    expect(await refusal(context.journey.createSpace(request('host-root')))).toBe('root_activation_required');
    const { spaceId } = await context.journey.rootActivationOptions({ op: 'create', request: request('host-root', { name: '  Root   work ' }) });
    const [, , asked] = context.seen.find(([step]) => step === 'options');
    expect(asked).toEqual({ op: 'create', spec: { id: spaceId, name: 'Root   work', project: hashProjectDirectory(PROJECT), memoryBytes: expect.any(Number) } });
    expect(await refusal(context.journey.createSpace(request('host-root', { name: '  Root   work ', spaceId })))).toBe('root_activation_required');
    expect(await created(context, request('host-root', { name: '  Root   work ', spaceId, rootActivation: ASSERTION }))).toBe(spaceId);
    const [, , spec, activation] = context.seen.find(([step]) => step === 'create');
    expect(activation).toEqual(ASSERTION);
    // What the place made is what was confirmed; only the creation time is new.
    expect(spec).toEqual({ ...asked.spec, created: expect.any(String) });
  });

  it('never runs an approval worker, and no other place takes a confirmation or an id from outside', async () => {
    const context = setup();
    const approval = { purpose: 'pr-fix-loop-approval', approvalModel: { providerID: 'anthropic', modelID: 'claude' }, network: { mode: 'allowlist', domains: [] } };
    expect(await refusal(context.journey.rootActivationOptions({ op: 'create', request: request('host-root', approval) }))).toBe('root_place_not_allowed');
    expect(await refusal(context.journey.createSpace(request('memory', { rootActivation: ASSERTION, spaceId: 'a1b2c3d4e5f6' })))).toBe('root_activation_unexpected');
    expect(await refusal(context.journey.createSpace(request('host', { spaceId: 'a1b2c3d4e5f6' })))).toBe('root_activation_unexpected');
    expect(await refusal(context.journey.rootActivationOptions({ op: 'create', request: request('host') }))).toBe('root_activation_unexpected');
    expect(context.seen.filter(([step]) => step === 'create')).toEqual([]);
  });

  it('starts and restarts only with a confirmation, and a restart without one leaves it running', async () => {
    const context = setup();
    const spaceId = await createdRoot(context);
    expect(await refusal(context.journey.restartSpace(spaceId))).toBe('root_activation_required');
    expect((await context.journey.listSpaces()).find((space) => space.id === spaceId)).toMatchObject({ state: 'running', kind: 'host-root' });
    await context.journey.stopSpace(spaceId);
    expect(await refusal(context.journey.startSpace(spaceId))).toBe('root_activation_required');
    expect(context.seen.filter(([step]) => step === 'start')).toEqual([]);
    expect(await refusal(context.journey.startSpace(spaceId, { rootActivation: { ...ASSERTION, type: 'password' } }))).toBe('root_activation_invalid');
    await context.journey.startSpace(spaceId, { rootActivation: ASSERTION });
    expect(context.seen.filter(([step]) => step === 'start')).toEqual([['start', 'host-root', spaceId, ASSERTION]]);
    await context.journey.rootActivationOptions({ op: 'start', spaceId });
    expect(context.seen.at(-1)).toEqual(['options', 'host-root', { op: 'start', id: spaceId }]);
  });

  it('is not started for its chats by a delete, which asks for no confirmation', async () => {
    const saves = [];
    const context = setup({ archiveChats: async (request) => { saves.push(request); return { saved: false, reason: 'not_running' }; } });
    const spaceId = await createdRoot(context);
    await context.journey.stopSpace(spaceId);
    await context.journey.removeSpace(spaceId, { allowUnsaved: true });
    expect(context.seen.filter(([step]) => step === 'start')).toEqual([]);
    expect(saves).toEqual([expect.objectContaining({ spaceId, running: false })]);
  });

  it('says the root component cannot be asked when hostd is missing', async () => {
    expect(await setup().journey.readRootPasskeys()).toEqual({ available: false, reason: 'hostd_unavailable', passkeys: [] });
  });

  it('takes no confirmation on the start of any other space', async () => {
    const context = setup();
    const spaceId = await created(context, request('host'));
    await context.journey.stopSpace(spaceId);
    expect(await refusal(context.journey.startSpace(spaceId, { rootActivation: ASSERTION }))).toBe('root_activation_unexpected');
  });
});

describe('protected MCP connections of a space', () => {
  it('are given to a space on this computer\'s users through its own subject, then remembered and named inside', async () => {
    const context = setup();
    const spaceId = await created(context, request('host'));
    const { grant } = await context.journey.grantAccess(spaceId, { kind: 'mcp', connection: CONNECTION, name: 'jira' });
    expect(grant).toEqual({ kind: 'mcp', id: 'mcp-jira', connection: CONNECTION, name: 'jira' });
    expect(context.seen.filter(([step]) => step === 'subject-set').at(-1)).toEqual(['subject-set', `space-${spaceId}`, [CONNECTION]]);
    expect(context.records.read(spaceId).record.grants).toEqual([grant]);
    expect(context.configs.at(-1)).toEqual([spaceId, [grant]]);
    // The gatekeeper holds no MCP grant, so a running space never lists it as needing access.
    expect((await context.journey.listSpaces({ access: true })).find((space) => space.id === spaceId)).toMatchObject({ needsAccess: [] });
  });

  it('are refused for a Docker space, and nothing reaches the protected MCP service', async () => {
    const context = setup();
    const spaceId = await created(context, request('memory'));
    expect(await refusal(context.journey.grantAccess(spaceId, { kind: 'mcp', connection: CONNECTION, name: 'jira' }))).toBe('mcp_grant_unsupported_place');
    expect(context.seen.some(([step]) => step.startsWith('subject-'))).toBe(false);
    expect(context.records.read(spaceId).record.grants).toEqual([]);
  });

  it('are not remembered when the service refuses them', async () => {
    for (const [code, expected] of [['unknown_connection', 'mcp_connection_not_found'], ['protected_mcp_unavailable', 'protected_mcp_unavailable']]) {
      const context = setup({ subjects: async (action, _subject, connections) => (action === 'set' && connections.length > 0 ? { ok: false, code } : { ok: true }) });
      const spaceId = await created(context, request('host'));
      expect(await refusal(context.journey.grantAccess(spaceId, { kind: 'mcp', connection: CONNECTION, name: 'jira' }))).toBe(expected);
      expect(context.records.read(spaceId).record.grants).toEqual([]);
    }
  });

  it('are said to the subject before a start, and the subject goes first when the space is deleted', async () => {
    const context = setup();
    const spaceId = await created(context, request('host'));
    await context.journey.grantAccess(spaceId, { kind: 'mcp', connection: CONNECTION, name: 'jira' });
    await context.journey.stopSpace(spaceId);
    context.seen.length = 0;
    await context.journey.startSpace(spaceId);
    const steps = context.seen.map(([step]) => step);
    expect(context.seen[steps.indexOf('subject-set')]).toEqual(['subject-set', `space-${spaceId}`, [CONNECTION]]);
    expect(steps.indexOf('subject-set')).toBeLessThan(steps.indexOf('start'));
    context.seen.length = 0;
    await context.journey.removeSpace(spaceId, { allowUnsaved: true });
    expect(context.seen.map(([step]) => step)).toEqual(['subject-remove', 'remove']);
  });
});
