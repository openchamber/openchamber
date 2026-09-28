// The journey over the memory place, with stand-ins for the gatekeeper channel, code in and code
// out that record what they were asked. What is under test is the order of the steps, what the
// host remembers, what it announces, and what a failure leaves.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { createSpaceJourney } from './journey.js';
import { ROLE_GATEKEEPER, spaceResourceName } from './labels.js';
import { createSpaceManager } from './manager.js';
import { createMemoryPlace } from './places/memory-place.js';
import { createPlaceRegistry } from './places/registry.js';
import { createSpaceRecords } from './space-records.js';

const PROJECT = '/home/me/project';
const NETWORK = { mode: 'allowlist', domains: ['api.anthropic.com'] };
const BASE = 'b'.repeat(40);
const quiet = { warn: () => {} };
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

/** A journey on fresh stand-ins. `failAt` names a stand-in step that rejects. */
const journeyWith = ({ failAt = null, place = createMemoryPlace(), projects = [PROJECT], historyStatus = 'sent', holdCodeIn = false, holdCodeOut = false, holdIdleSave = false, hostEnvironment = {}, dataDir = null } = {}) => {
  // With `holdCodeIn`, code in waits until the test lets it go, so a creation stays under way;
  // `holdCodeOut` does the same for the fetch of an apply.
  let releaseCodeIn = () => {};
  const codeInHeld = new Promise((resolve) => { releaseCodeIn = resolve; });
  let releaseCodeOut = () => {};
  const codeOutHeld = new Promise((resolve) => { releaseCodeOut = resolve; });
  if (dataDir === null) {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-journey-'));
    folders.push(dataDir);
  }
  const calls = [];
  const events = [];
  const changes = { count: 0 };
  const fail = (step) => { if (failAt === step) throw new SpaceError(`${step}_failed`, `the stand-in for ${step} failed`); };
  // The stand-in gatekeeper holds grant ids per space, like the program's memory: a stop forgets them.
  const held = new Map();
  const gatekeeper = {
    setNetwork: async (spaceId, network) => { calls.push(['setNetwork', spaceId, network]); fail('setNetwork'); },
    addGrant: async (spaceId, grant) => { calls.push(['addGrant', spaceId, grant]); fail('addGrant'); if (!held.has(spaceId)) held.set(spaceId, new Set()); held.get(spaceId).add(grant.id); },
    readPolicy: async (spaceId) => { calls.push(['readPolicy', spaceId]); fail('readPolicy'); return { mode: 'allowlist', domains: [], grants: Array.from(held.get(spaceId) ?? []) }; },
    readJournal: async (spaceId) => { calls.push(['readJournal', spaceId]); return { records: [], dropped: 0, since: '2026-09-26T10:00:00.000Z' }; },
    forget: (spaceId) => { held.delete(spaceId); },
  };
  // The idle stop setting as the host keeps it, and each one said to a server inside, apart from
  // `calls` so the order of the other steps reads as it did before 5d-3.
  const idle = { saved: null, writes: [], release: () => {} };
  const idleSaveHeld = new Promise((resolve) => { idle.release = resolve; });
  const serverInside = {
    writeToken: async (spaceId, token) => { calls.push(['writeToken', spaceId, token]); fail('writeToken'); },
    writeIdleStop: async (spaceId, setting) => { fail('writeIdleStop'); idle.writes.push([spaceId, setting]); },
  };
  const restartOpenCodeInside = async (spaceId) => { calls.push(['restartOpenCodeInside', spaceId]); fail('restartOpenCodeInside'); };
  const spaceOpenCode = {
    writeProviderConfig: async (spaceId, grants) => { calls.push(['writeProviderConfig', spaceId, grants]); fail('writeProviderConfig'); },
  };
  const codeIn = {
    bringCodeIn: async (request) => {
      calls.push(['bringCodeIn', request]);
      if (holdCodeIn) await codeInHeld;
      fail('bringCodeIn');
      return { spacePath: `/spaces/${request.spaceId}/project`, projectPath: `/spaces/${request.spaceId}/project`, base: BASE, identityCopied: { name: true, email: false } };
    },
    sendHistory: async (request) => { calls.push(['sendHistory', request]); fail('sendHistory'); return { status: historyStatus }; },
    removeSpaceRefs: async (request) => { calls.push(['removeSpaceRefs', request]); fail('removeSpaceRefs'); },
  };
  const codeOut = {
    bringCodeOut: async (request) => { calls.push(['bringCodeOut', request]); if (holdCodeOut) await codeOutHeld; fail('bringCodeOut'); return { result: 'c'.repeat(40), changedPaths: 3, changedBytes: 10, nestedRepositories: { count: 0, paths: [] }, unmerged: { count: 0, paths: [] } }; },
    describeApplyState: async (request) => { calls.push(['describeApplyState', request]); return { closed: false, newPaths: 3 }; },
    applyAsBranch: async (request) => { calls.push(['applyAsBranch', request]); fail('applyAsBranch'); return { branch: request.branch, commit: 'c'.repeat(40) }; },
    applyAsChanges: async (request) => { calls.push(['applyAsChanges', request]); fail('applyAsChanges'); return { status: failAt === 'nothing' ? 'nothing_to_apply' : 'applied', appliedPaths: 3, remembered: true }; },
  };
  const records = createSpaceRecords({ dataDir, logger: quiet });
  const manager = createSpaceManager({ registry: createPlaceRegistry([place]), now: () => new Date('2026-09-26T10:00:00.000Z') });
  const journey = createSpaceJourney({
    manager, place, gatekeeper, codeIn, codeOut, records, spaceOpenCode, serverInside, restartOpenCodeInside,
    listProjectDirectories: async () => projects,
    readHostSecret: (name) => hostEnvironment[name],
    readIdleStop: async () => idle.saved ?? { enabled: true, hours: 4 },
    saveIdleStop: async (setting) => { if (holdIdleSave) await idleSaveHeld; fail('saveIdleStop'); idle.saved = setting; },
    announce: (spaceId, payload) => { events.push({ spaceId, ...payload.properties }); },
    onSpacesChanged: () => { changes.count += 1; },
    logger: quiet,
    now: () => new Date('2026-09-26T10:00:00.000Z'),
  });
  return { journey, place, records, calls, events, changes, manager, releaseCodeIn, releaseCodeOut, gatekeeper, dataDir, idle };
};

const REQUEST = { projectDirectory: PROJECT, name: ' Fix login ', start: 'uncommitted', network: NETWORK };
const steps = (events, spaceId) => events.filter((event) => event.spaceId === spaceId).map((event) => event.step);

describe('the journey: create', () => {
  it('answers at once, then makes the space, sets its network, brings the code in and sends the history behind it', async () => {
    const { journey, place, records, calls, events, changes } = journeyWith();

    const answer = await journey.createSpace(REQUEST);
    expect(answer).toMatchObject({ id: expect.stringMatching(/^[0-9a-f]{12}$/), name: 'Fix login', placeId: 'memory', projectDirectory: PROJECT, directory: `/spaces/${answer.id}/project`, state: 'preparing', step: 'checking_place', network: NETWORK, history: 'pending' });
    // Listed as preparing while the steps run, whether or not the place has it yet.
    expect((await journey.listSpaces()).find((space) => space.id === answer.id)).toMatchObject({ state: 'preparing' });

    expect(await until(() => steps(events, answer.id).includes('ready'))).toBe(true);
    expect(steps(events, answer.id)).toEqual(['checking_place', 'creating', 'setting_network', 'bringing_code', 'ready']);
    expect(await place.list()).toEqual([expect.objectContaining({ id: answer.id, name: 'Fix login', state: 'running' })]);
    expect(calls.map(([name]) => name).slice(0, 3)).toEqual(['setNetwork', 'bringCodeIn', 'sendHistory']);
    expect(calls[0]).toEqual(['setNetwork', answer.id, NETWORK]);
    expect(calls[1][1]).toEqual({ repository: PROJECT, spaceId: answer.id, mode: 'uncommitted' });
    expect(calls[2][1]).toEqual({ repository: PROJECT, spaceId: answer.id, spacePath: `/spaces/${answer.id}/project`, base: BASE });
    expect(await until(() => records.read(answer.id).record?.history === 'sent')).toBe(true);
    expect(records.read(answer.id).record).toMatchObject({ network: NETWORK, repository: PROJECT, spacePath: `/spaces/${answer.id}/project`, base: BASE });
    expect(changes.count).toBeGreaterThan(0);

    const listed = await journey.listSpaces();
    expect(listed).toEqual([expect.objectContaining({ id: answer.id, state: 'running', step: null, failure: null, network: NETWORK, history: 'sent', damaged: false })]);
  });

  it('keeps the space and marks the history failed when only the history did not arrive', async () => {
    const { journey, records, events } = journeyWith({ failAt: 'sendHistory' });
    const { id } = await journey.createSpace(REQUEST);
    expect(await until(() => steps(events, id).includes('ready'))).toBe(true);
    expect(await until(() => records.read(id).record?.history === 'failed')).toBe(true);
    expect((await journey.listSpaces())[0]).toMatchObject({ id, state: 'running', history: 'failed' });
  });

  it.each(['setNetwork', 'bringCodeIn'])('removes what it made when %s fails, and lists the failure until it is dismissed', async (failAt) => {
    const { journey, place, records, calls, events } = journeyWith({ failAt });
    const { id } = await journey.createSpace(REQUEST);
    expect(await until(() => steps(events, id).includes('failed'))).toBe(true);

    expect(await place.list()).toEqual([]);
    expect(records.read(id)).toEqual({ status: 'missing', record: null });
    expect(calls.find(([name]) => name === 'removeSpaceRefs')?.[1]).toEqual({ repository: PROJECT, spaceId: id });
    const failure = events.find((event) => event.spaceId === id && event.step === 'failed').failure;
    expect(failure).toMatchObject({ code: `${failAt}_failed`, message: expect.stringContaining(failAt) });
    expect(await journey.listSpaces()).toEqual([expect.objectContaining({ id, state: 'failed', step: 'failed', failure: expect.objectContaining({ code: `${failAt}_failed` }) })]);

    // The failure is dismissed by removing it; the place is not asked, there is nothing there.
    expect(await journey.removeSpace(id)).toEqual({ id, removed: true, refsRemoved: null, failures: [] });
    expect(await journey.listSpaces()).toEqual([]);
  });

  it('does not make a space when the place is unavailable, and names the reason', async () => {
    const place = { ...createMemoryPlace(), check: async () => ({ available: false, code: 'docker_daemon_unreachable', message: 'Docker is installed but not running.' }) };
    const { journey, events } = journeyWith({ place });
    const { id } = await journey.createSpace(REQUEST);
    expect(await until(() => steps(events, id).includes('failed'))).toBe(true);
    expect(steps(events, id)).toEqual(['checking_place', 'failed']);
    expect(events.at(-1).failure).toMatchObject({ code: 'docker_daemon_unreachable', message: 'Docker is installed but not running.' });
    expect(await place.list()).toEqual([]);
  });

  it('refuses an allowlist on a place that cannot keep the space away from its host', async () => {
    const place = { ...createMemoryPlace(), check: async () => ({ available: true, version: '26.0.0', hostIsolation: false }) };
    const { journey, events } = journeyWith({ place });
    const { id } = await journey.createSpace(REQUEST);
    expect(await until(() => steps(events, id).includes('failed'))).toBe(true);
    expect(events.at(-1).failure.code).toBe('place_cannot_restrict_network');
    expect(await place.list()).toEqual([]);
    // Open is taken there, with the design's warning left to the funnel.
    const open = await journey.createSpace({ ...REQUEST, network: { mode: 'open' } });
    expect(await until(() => steps(events, open.id).includes('ready'))).toBe(true);
  });

  it('refuses a bad request before anything runs', async () => {
    const { journey, place, events } = journeyWith();
    await expect(journey.createSpace({ ...REQUEST, projectDirectory: '/home/me/other' })).rejects.toMatchObject({ code: 'project_not_registered' });
    await expect(journey.createSpace({ ...REQUEST, projectDirectory: '' })).rejects.toMatchObject({ code: 'project_not_registered' });
    await expect(journey.createSpace({ ...REQUEST, start: 'yesterday' })).rejects.toMatchObject({ code: 'invalid_snapshot_mode' });
    await expect(journey.createSpace({ ...REQUEST, network: { mode: 'allowlist', domains: ['10.0.0.1'] } })).rejects.toMatchObject({ code: 'invalid_network' });
    await expect(journey.createSpace({ ...REQUEST, network: { mode: 'everything' } })).rejects.toMatchObject({ code: 'invalid_network' });
    await expect(journey.createSpace({ ...REQUEST, name: '   ' })).rejects.toMatchObject({ code: 'invalid_space_name' });
    await expect(journey.createSpace({ ...REQUEST, name: 7 })).rejects.toMatchObject({ code: 'invalid_space_name' });
    expect(events).toEqual([]);
    expect(await place.list()).toEqual([]);
  });
});

describe('the journey: start, stop, remove', () => {
  const ready = async (options) => {
    const made = journeyWith(options);
    const { id } = await made.journey.createSpace(REQUEST);
    await until(() => steps(made.events, id).includes('ready'));
    await until(() => made.records.read(id).record?.history !== 'pending');
    made.calls.splice(0);
    return { ...made, id };
  };

  it('stops a space and starts it again with its network said again to the gatekeeper', async () => {
    const { journey, place, calls, id, changes } = await ready();
    const before = changes.count;
    expect(await journey.stopSpace(id)).toMatchObject({ id, state: 'exited', network: NETWORK });
    expect(await place.list()).toEqual([expect.objectContaining({ state: 'exited' })]);
    expect(calls).toEqual([]);

    const started = await journey.startSpace(id);
    expect(started).toMatchObject({ id, state: 'running', networkRestored: true });
    expect(calls).toEqual([['setNetwork', id, NETWORK]]);
    expect(changes.count).toBe(before + 2);
  });

  it('starts a space whose record is gone with its network left closed, and says so', async () => {
    const { journey, records, calls, id } = await ready();
    await journey.stopSpace(id);
    records.remove(id);
    expect(await journey.startSpace(id)).toMatchObject({ id, state: 'running', networkRestored: false, network: null, history: 'unknown' });
    expect(calls).toEqual([]);
  });

  it('sends the history again at start when it never arrived or failed', async () => {
    const { journey, records, calls, id } = await ready({ failAt: 'sendHistory' });
    expect(records.read(id).record.history).toBe('failed');
    await journey.stopSpace(id);
    await journey.startSpace(id);
    expect(calls.map(([name]) => name)).toEqual(['setNetwork', 'sendHistory']);
    calls.splice(0);
    records.update(id, { history: 'sent' });
    await journey.stopSpace(id);
    await journey.startSpace(id);
    expect(calls.map(([name]) => name)).toEqual(['setNetwork']);
  });

  it('removes the space, the refs in the user\'s repository and the record', async () => {
    const { journey, place, records, calls, id } = await ready();
    expect(await journey.removeSpace(id)).toEqual({ id, removed: true, refsRemoved: true, failures: [] });
    expect(calls).toEqual([['removeSpaceRefs', { repository: PROJECT, spaceId: id }]]);
    expect(await place.list()).toEqual([]);
    expect(records.read(id).status).toBe('missing');
    await expect(journey.removeSpace(id)).rejects.toMatchObject({ code: 'space_not_found' });
  });

  it('reports refs that could not be removed, with the space gone all the same', async () => {
    const { journey, place, id } = await ready({ failAt: 'removeSpaceRefs' });
    const outcome = await journey.removeSpace(id);
    expect(outcome).toMatchObject({ id, removed: true, refsRemoved: false, failures: [expect.objectContaining({ code: 'removeSpaceRefs_failed' })] });
    expect(await place.list()).toEqual([]);
  });

  it('refuses to start, stop or remove a space that is still being made', async () => {
    const { journey, events, releaseCodeIn } = journeyWith({ holdCodeIn: true });
    const { id } = await journey.createSpace(REQUEST);
    expect(await until(() => steps(events, id).includes('bringing_code'))).toBe(true);
    await expect(journey.stopSpace(id)).rejects.toMatchObject({ code: 'space_preparing' });
    await expect(journey.startSpace(id)).rejects.toMatchObject({ code: 'space_preparing' });
    await expect(journey.removeSpace(id)).rejects.toMatchObject({ code: 'space_preparing' });
    await expect(journey.previewApply(id)).rejects.toMatchObject({ code: 'space_preparing' });
    releaseCodeIn();
    expect(await until(() => steps(events, id).includes('ready'))).toBe(true);
    expect(await journey.stopSpace(id)).toMatchObject({ state: 'exited' });
  });

  it('stops every running space for the switch, and reports the one that would not stop as still running', async () => {
    const { journey, place, manager } = await ready();
    const second = await manager.createSpace({ placeId: 'memory', projectDirectory: PROJECT, name: 'Second' });
    const third = await manager.createSpace({ placeId: 'memory', projectDirectory: PROJECT, name: 'Third' });
    await place.stop(third.id);
    const stop = place.stop;
    place.stop = async (spaceId) => { if (spaceId === second.id) throw new SpaceError('docker_command_failed', 'docker stop exited 1'); return stop(spaceId); };

    const outcome = await journey.stopAllSpaces();
    expect(outcome.stopped).toEqual([expect.objectContaining({ name: 'Fix login' })]);
    expect(outcome.stillRunning).toEqual([{ id: second.id, name: 'Second', code: 'docker_command_failed', message: 'docker stop exited 1', details: null }]);
    expect((await place.list()).map((space) => space.state).sort()).toEqual(['exited', 'exited', 'running']);
  });

  it('turns off without the list when the place cannot give one, and says it does not know what runs', async () => {
    const { journey, place } = await ready();
    place.list = async () => { throw new SpaceError('docker_command_failed', 'docker ps exited 1'); };
    expect(await journey.stopAllSpaces()).toEqual({ stopped: [], stillRunning: [], unknown: { code: 'docker_command_failed', message: 'docker ps exited 1', details: null } });
    await expect(journey.createSpace(REQUEST)).rejects.toMatchObject({ code: 'isolated_spaces_off' });
  });

  it('does not turn the switch off while a space is being made', async () => {
    const { journey, events, releaseCodeIn } = journeyWith({ holdCodeIn: true });
    const { id } = await journey.createSpace(REQUEST);
    expect(await until(() => steps(events, id).includes('bringing_code'))).toBe(true);
    await expect(journey.stopAllSpaces()).rejects.toMatchObject({ code: 'space_preparing', details: { spaces: [id] } });
    releaseCodeIn();
    expect(await until(() => steps(events, id).includes('ready'))).toBe(true);
    expect(await journey.stopAllSpaces()).toEqual({ stopped: [{ id, name: 'Fix login' }], stillRunning: [] });
  });

  it('takes no creation and no start once the switch is being turned off, until the turn-off is undone', async () => {
    const { journey, manager } = journeyWith();
    const stopped = await manager.createSpace({ placeId: 'memory', projectDirectory: PROJECT, name: 'Stopped' });
    await journey.stopAllSpaces();
    await expect(journey.createSpace(REQUEST)).rejects.toMatchObject({ code: 'isolated_spaces_off' });
    await expect(journey.startSpace(stopped.id)).rejects.toMatchObject({ code: 'isolated_spaces_off' });
    journey.reopen();
    expect((await journey.startSpace(stopped.id)).state).toBe('running');
    const { id } = await journey.createSpace(REQUEST);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it('removes the containers of a failed creation whose clean-up failed when it is dismissed', async () => {
    const place = createMemoryPlace();
    const remove = place.remove;
    let refusals = 1;
    place.remove = async (spaceId) => {
      if (refusals > 0) { refusals -= 1; throw new SpaceError('docker_command_failed', 'docker rm exited 1'); }
      return remove(spaceId);
    };
    const { journey, events } = journeyWith({ place, failAt: 'bringCodeIn' });
    const { id } = await journey.createSpace(REQUEST);
    expect(await until(() => steps(events, id).includes('failed'))).toBe(true);
    expect(events.at(-1).failure.cleanup).toEqual([expect.objectContaining({ code: 'docker_command_failed' })]);
    expect(await place.list()).toHaveLength(1);
    await expect(journey.startSpace(id)).rejects.toMatchObject({ code: 'space_creation_failed' });

    expect(await journey.removeSpace(id)).toMatchObject({ id, removed: true });
    expect(await place.list()).toEqual([]);
    expect(await journey.listSpaces()).toEqual([]);
  });
});

describe('the journey: repair', () => {
  const ready = async (options) => {
    const made = journeyWith(options);
    const { id } = await made.journey.createSpace(REQUEST);
    await until(() => steps(made.events, id).includes('ready'));
    await until(() => made.records.read(id).record?.history !== 'pending');
    made.calls.splice(0);
    return { ...made, id };
  };

  /** Damages the one space of a memory place after it was made: its gatekeeper missing, and gone for good or only stopped. */
  const damage = (place, gatekeeper) => {
    const list = place.list;
    place.list = async () => (await list()).map((space) => ({ ...space, damaged: true, missing: [spaceResourceName(space.id, ROLE_GATEKEEPER)] }));
    place.verify = async () => {
      if (gatekeeper === 'unverifiable') throw new SpaceError('command_failed', 'docker did not answer');
      return gatekeeper === 'gone' ? [{ check: 'gatekeeper_missing', message: 'The space has no gatekeeper container' }] : [];
    };
  };

  it('restarts OpenCode inside a running space and nothing else', async () => {
    const { journey, calls, id } = await ready();
    expect(await journey.restartOpenCode(id)).toMatchObject({ id, state: 'running' });
    expect(calls).toEqual([['restartOpenCodeInside', id]]);
  });

  it('restarts the container with a fresh token written first, then stops and starts it with its network said again', async () => {
    const { journey, place, calls, id } = await ready();
    // The place's own steps, in the order they came, beside the stand-ins': the server inside
    // reads the new token only when the container starts again after a stop.
    for (const step of ['stop', 'start']) {
      const run = place[step];
      place[step] = async (spaceId) => { calls.push([step, spaceId]); return run(spaceId); };
    }
    const started = await journey.restartSpace(id);
    expect(started).toMatchObject({ id, state: 'running', networkRestored: true });
    expect(calls.map(([name]) => name)).toEqual(['writeToken', 'stop', 'start', 'setNetwork']);
    expect(calls[0][2]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await place.list()).toEqual([expect.objectContaining({ state: 'running' })]);
    // A second restart writes another token.
    const first = calls[0][2];
    calls.splice(0);
    await journey.restartSpace(id);
    expect(calls[0][0]).toBe('writeToken');
    expect(calls[0][2]).not.toBe(first);
  });

  it('restarts the container even when the token could not be written, because the token is no secret from the agent', async () => {
    const { journey, calls, id } = await ready({ failAt: 'writeToken' });
    expect(await journey.restartSpace(id)).toMatchObject({ id, state: 'running', networkRestored: true });
    expect(calls.map(([name]) => name)).toEqual(['writeToken', 'setNetwork']);
  });

  it('refuses both restarts for a stopped space, and says why OpenCode did not restart', async () => {
    const { journey, calls, id } = await ready();
    await journey.stopSpace(id);
    await expect(journey.restartSpace(id)).rejects.toMatchObject({ code: 'space_not_running' });
    await expect(journey.restartOpenCode(id)).rejects.toMatchObject({ code: 'space_not_running' });
    expect(calls).toEqual([]);

    const failing = await ready({ failAt: 'restartOpenCodeInside' });
    await expect(failing.journey.restartOpenCode(failing.id)).rejects.toMatchObject({ code: 'restartOpenCodeInside_failed' });
  });

  it('lists what is broken: nothing, a gatekeeper that a restart brings back, or one that is gone for good', async () => {
    const healthy = await ready();
    expect((await healthy.journey.listSpaces())[0]).toMatchObject({ damaged: false, damage: null });

    for (const [gatekeeper, expected] of [['stopped', 'repairable'], ['gone', 'gatekeeper_gone'], ['unverifiable', 'repairable']]) {
      const { journey, place } = await ready();
      damage(place, gatekeeper);
      expect((await journey.listSpaces())[0]).toMatchObject({ damaged: true, damage: expected });
    }
  });
});

describe('the journey: opening a domain', () => {
  const ready = async (options = {}, request = REQUEST) => {
    const made = journeyWith(options);
    const { id } = await made.journey.createSpace(request);
    await until(() => steps(made.events, id).includes('ready'));
    made.calls.splice(0);
    return { ...made, id };
  };

  it('tells the gatekeeper the allowlist with the domain, then remembers it for the next start', async () => {
    const { journey, records, calls, id } = await ready();
    expect(await journey.openDomain(id, { domain: ' Registry.NPMJS.org ' })).toEqual({ network: { mode: 'allowlist', domains: ['api.anthropic.com', 'registry.npmjs.org'] } });
    expect(calls).toEqual([['setNetwork', id, { mode: 'allowlist', domains: ['api.anthropic.com', 'registry.npmjs.org'] }]]);
    expect(records.read(id).record.network.domains).toEqual(['api.anthropic.com', 'registry.npmjs.org']);

    // A domain already on the list changes nothing.
    calls.splice(0);
    expect(await journey.openDomain(id, { domain: 'registry.npmjs.org' })).toEqual({ network: { mode: 'allowlist', domains: ['api.anthropic.com', 'registry.npmjs.org'] } });
    expect(calls).toEqual([]);

    // The next start says the list with the opened domain again.
    await journey.stopSpace(id);
    calls.splice(0);
    await journey.startSpace(id);
    expect(calls.find(([name]) => name === 'setNetwork')).toEqual(['setNetwork', id, { mode: 'allowlist', domains: ['api.anthropic.com', 'registry.npmjs.org'] }]);
  });

  it('refuses what is not a name, a stopped space, an open network, and a record it cannot read, telling the gatekeeper nothing', async () => {
    const { journey, records, calls, id } = await ready();
    for (const domain of ['', 'localhost', '10.0.0.1', '1746020849', 'a_b.example.com', 'example.com/path', 'https://example.com', '*.example.com']) {
      await expect(journey.openDomain(id, { domain }), domain).rejects.toMatchObject({ code: 'invalid_domain' });
    }
    await expect(journey.openDomain(id, { domain: 'example.com', extra: 1 })).rejects.toMatchObject({ code: 'invalid_domain' });
    await expect(journey.openDomain(id, null)).rejects.toMatchObject({ code: 'invalid_domain' });
    records.update(id, { network: { mode: 'open', domains: [] } });
    await expect(journey.openDomain(id, { domain: 'example.com' })).rejects.toMatchObject({ code: 'network_is_open' });
    records.remove(id);
    await expect(journey.openDomain(id, { domain: 'example.com' })).rejects.toMatchObject({ code: 'space_record_unreadable' });
    await journey.stopSpace(id);
    await expect(journey.openDomain(id, { domain: 'example.com' })).rejects.toMatchObject({ code: 'space_not_running' });
    expect(calls.filter(([name]) => name === 'setNetwork')).toEqual([]);
  });

  it('does not remember a domain the gatekeeper did not take', async () => {
    const { records, place, dataDir, id } = await ready();
    // A second journey over the same place and records, whose gatekeeper refuses the change.
    const failing = journeyWith({ place, dataDir, failAt: 'setNetwork' });
    await expect(failing.journey.openDomain(id, { domain: 'example.com' })).rejects.toMatchObject({ code: 'setNetwork_failed' });
    expect(records.read(id).record.network.domains).toEqual(['api.anthropic.com']);
  });

  it('refuses a domain past the size of a list', async () => {
    const { journey, records, calls, id } = await ready();
    records.update(id, { network: { mode: 'allowlist', domains: Array.from({ length: 200 }, (_, index) => `d${index}.example.com`) } });
    await expect(journey.openDomain(id, { domain: 'one-more.example.com' })).rejects.toMatchObject({ code: 'too_many_domains' });
    expect(calls).toEqual([]);
  });
});

describe('the journey: grants', () => {
  const KEY = 'sk-live-typed-once';
  const ENV_KEY = 'sk-live-from-the-host-environment';
  const ready = async (options) => {
    const made = journeyWith(options);
    const { id } = await made.journey.createSpace(REQUEST);
    await until(() => steps(made.events, id).includes('ready'));
    await until(() => made.records.read(id).record?.history !== 'pending');
    made.calls.splice(0);
    return { ...made, id };
  };
  const anthropic = { kind: 'model', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', secret: { kind: 'typed', value: KEY } };
  const openai = { kind: 'model', provider: 'openai', upstream: 'https://api.openai.com/v1', secret: { kind: 'env', name: 'OPENAI_API_KEY' } };
  const registry = { kind: 'domain', upstream: 'https://registry.example.com/npm/' };

  it('gives a model key to the gatekeeper, remembers the grant without the key, and points OpenCode inside at the window', async () => {
    const { journey, records, calls, id } = await ready({ hostEnvironment: { OPENAI_API_KEY: ENV_KEY } });
    const typed = await journey.grantAccess(id, anthropic);
    expect(typed).toEqual({ grant: { kind: 'model', id: 'anthropic', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', header: 'x-api-key', source: { kind: 'typed' }, url: 'http://gatekeeper:8080/model/anthropic' } });
    const fromEnv = await journey.grantAccess(id, openai);
    expect(fromEnv.grant).toMatchObject({ id: 'openai', header: 'authorization', source: { kind: 'env', name: 'OPENAI_API_KEY' } });

    expect(calls).toEqual([
      ['addGrant', id, { id: 'anthropic', upstream: 'https://api.anthropic.com/v1', header: 'x-api-key', secret: KEY }],
      ['writeProviderConfig', id, [expect.objectContaining({ id: 'anthropic' })]],
      ['addGrant', id, { id: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', secret: ENV_KEY }],
      ['writeProviderConfig', id, [expect.objectContaining({ id: 'anthropic' }), expect.objectContaining({ id: 'openai' })]],
    ]);
    // The record holds both grants and neither key, in the file as on the way out.
    const { record } = records.read(id);
    expect(record.grants.map((grant) => grant.id)).toEqual(['anthropic', 'openai']);
    const onDisk = JSON.stringify(record);
    expect(onDisk).not.toContain(KEY);
    expect(onDisk).not.toContain(ENV_KEY);
    expect(JSON.stringify(await journey.listSpaces({ access: true }))).not.toContain(KEY);
  });

  it('replaces the grant of the same provider, and opens a domain with no key and no header', async () => {
    const { journey, records, calls, id } = await ready();
    await journey.grantAccess(id, anthropic);
    await journey.grantAccess(id, { ...anthropic, secret: { kind: 'typed', value: 'sk-live-newer' } });
    expect(records.read(id).record.grants).toHaveLength(1);
    expect(calls.filter(([name]) => name === 'addGrant').at(-1)[2].secret).toBe('sk-live-newer');

    calls.splice(0);
    const opened = await journey.grantAccess(id, registry);
    expect(opened.grant).toEqual({ kind: 'domain', id: expect.stringMatching(/^open-[0-9a-f]{12}$/), upstream: 'https://registry.example.com/npm/', url: `http://gatekeeper:8080/model/${opened.grant.id}` });
    // No header, no secret, and OpenCode inside is not told about a domain.
    expect(calls).toEqual([['addGrant', id, { id: opened.grant.id, upstream: 'https://registry.example.com/npm/', header: null, secret: null }]]);
    expect(records.read(id).record.grants.map((grant) => grant.kind)).toEqual(['model', 'domain']);
  });

  it('refuses a grant it cannot give: a bad request, a stopped space, a key the host cannot find, a record it cannot read', async () => {
    const { journey, records, calls, id } = await ready();
    for (const bad of [
      { kind: 'model', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1' },
      { kind: 'model', provider: 'anthropic', upstream: 'ftp://api.anthropic.com/v1', secret: { kind: 'typed', value: KEY } },
      { kind: 'model', provider: 'anthropic', upstream: 'not a url', secret: { kind: 'typed', value: KEY } },
      { kind: 'domain', upstream: 'not a url' },
      { kind: 'model', provider: '../x', upstream: 'https://api.anthropic.com/v1', secret: { kind: 'typed', value: KEY } },
      { kind: 'model', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', secret: { kind: 'typed', value: '' } },
      { kind: 'model', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', secret: { kind: 'env', name: 'not a name' } },
      { kind: 'model', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', secret: { kind: 'file', name: '/tmp/key' } },
      { kind: 'domain', upstream: 'https://registry.example.com/', secret: { kind: 'typed', value: KEY } },
      { kind: 'ssh' },
      null,
    ]) {
      await expect(journey.grantAccess(id, bad), JSON.stringify(bad)).rejects.toMatchObject({ code: 'invalid_grant_request' });
    }
    await expect(journey.grantAccess(id, openai)).rejects.toMatchObject({ code: 'secret_source_missing', message: expect.stringContaining('OPENAI_API_KEY') });
    // A provider that reads its key another way is refused, never accepted to fail every turn.
    await expect(journey.grantAccess(id, { ...anthropic, provider: 'azure' })).rejects.toMatchObject({ code: 'provider_not_supported' });
    expect(calls).toEqual([]);
    expect(records.read(id).record.grants).toEqual([]);

    records.remove(id);
    await expect(journey.grantAccess(id, anthropic)).rejects.toMatchObject({ code: 'space_record_unreadable' });
    await journey.stopSpace(id);
    await expect(journey.grantAccess(id, anthropic)).rejects.toMatchObject({ code: 'space_not_running' });
    expect(calls.filter(([name]) => name === 'addGrant')).toEqual([]);
    await expect(journey.grantAccess('0f0f0f0f0f0f', anthropic)).rejects.toMatchObject({ code: 'space_not_found' });
  });

  it('keeps a grant whose configuration inside was not written, and writes it again at the next start', async () => {
    const { journey, records, calls, place, dataDir, id } = await ready();
    // A second journey over the same place and records, whose write inside fails.
    const failing = journeyWith({ place, dataDir, failAt: 'writeProviderConfig' });
    await expect(failing.journey.grantAccess(id, anthropic)).rejects.toMatchObject({ code: 'writeProviderConfig_failed' });
    // The key reached the gatekeeper and the grant is remembered: only the cooperation inside is missing.
    expect(records.read(id).record.grants.map((grant) => grant.id)).toEqual(['anthropic']);

    await journey.stopSpace(id);
    calls.splice(0);
    await journey.startSpace(id);
    expect(calls.filter(([name]) => name === 'writeProviderConfig')).toEqual([['writeProviderConfig', id, [expect.objectContaining({ id: 'anthropic' })]]]);
    // And a start whose write fails still starts.
    await failing.journey.stopSpace(id);
    expect(await failing.journey.startSpace(id)).toMatchObject({ state: 'running', networkRestored: true });
  });

  it('says nothing about access while an action holds the space', async () => {
    const { journey, id, releaseCodeOut } = await ready({ holdCodeOut: true });
    await journey.grantAccess(id, registry);
    expect((await journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'granted' });
    const applying = journey.applySpace(id, { as: 'changes' });
    await sleep(20);
    expect((await journey.listSpaces({ access: true }))[0]).toMatchObject({ access: null, needsAccess: [] });
    releaseCodeOut();
    await applying;
    expect((await journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'granted' });
  });

  it('does not remember a grant the gatekeeper refused', async () => {
    const { journey, records, id } = await ready({ failAt: 'addGrant' });
    await expect(journey.grantAccess(id, anthropic)).rejects.toMatchObject({ code: 'addGrant_failed' });
    expect(records.read(id).record.grants).toEqual([]);
  });

  it('says the grants again after a start: from the host environment yes, a typed key no, a domain yes', async () => {
    const { journey, calls, gatekeeper, id } = await ready({ hostEnvironment: { OPENAI_API_KEY: ENV_KEY } });
    await journey.grantAccess(id, anthropic);
    await journey.grantAccess(id, openai);
    const opened = await journey.grantAccess(id, registry);
    expect((await journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'granted', needsAccess: [] });

    await journey.stopSpace(id);
    gatekeeper.forget(id);
    calls.splice(0);
    const started = await journey.startSpace(id);
    expect(started).toMatchObject({ networkRestored: true, grantsRestored: ['openai', opened.grant.id], needsAccess: ['anthropic'], access: null });
    expect(calls.filter(([name]) => name === 'addGrant')).toEqual([
      ['addGrant', id, { id: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', secret: ENV_KEY }],
      ['addGrant', id, { id: opened.grant.id, upstream: 'https://registry.example.com/npm/', header: null, secret: null }],
    ]);
    // The typed key is not in anything the start sent or wrote.
    expect(JSON.stringify(calls)).not.toContain(KEY);
    // OpenCode's configuration inside is written again from the record, with both model grants,
    // so a write that failed at the grant is repaired here. It holds no key.
    expect(calls.filter(([name]) => name === 'writeProviderConfig')).toEqual([['writeProviderConfig', id, [expect.objectContaining({ id: 'anthropic' }), expect.objectContaining({ id: 'openai' }), expect.objectContaining({ id: opened.grant.id })]]]);

    // The list asks the gatekeeper and says which grant needs the user again.
    const listed = (await journey.listSpaces({ access: true }))[0];
    expect(listed).toMatchObject({ access: 'needs_access', needsAccess: ['anthropic'] });
    expect(listed.grants.map((grant) => grant.id)).toEqual(['anthropic', 'openai', opened.grant.id]);
    // Granting once more clears it.
    await journey.grantAccess(id, anthropic);
    expect((await journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'granted', needsAccess: [] });
  });

  it('needs the user again after a start when the host environment no longer has the key, and when the gatekeeper refuses', async () => {
    const withKey = await ready({ hostEnvironment: { OPENAI_API_KEY: ENV_KEY } });
    await withKey.journey.grantAccess(withKey.id, openai);
    await withKey.journey.stopSpace(withKey.id);
    withKey.gatekeeper.forget(withKey.id);
    // The same records, read by a journey whose host has no such variable now: nothing is sent, and the start says so.
    const without = journeyWith({ place: withKey.place, dataDir: withKey.dataDir, hostEnvironment: {} });
    expect(await without.journey.startSpace(withKey.id)).toMatchObject({ state: 'running', networkRestored: true, grantsRestored: [], needsAccess: ['openai'] });
    expect(without.calls.filter(([name]) => name === 'addGrant')).toEqual([]);
    expect((await without.journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'needs_access', needsAccess: ['openai'] });

    // A gatekeeper that refuses the grant at the start leaves the space running and the grant missing, never "restored".
    const refusing = await ready({ hostEnvironment: { OPENAI_API_KEY: ENV_KEY } });
    await refusing.journey.grantAccess(refusing.id, openai);
    await refusing.journey.stopSpace(refusing.id);
    refusing.gatekeeper.forget(refusing.id);
    refusing.gatekeeper.addGrant = async () => { throw new SpaceError('gatekeeper_refused', 'The gatekeeper refused to add the grant'); };
    expect(await refusing.journey.startSpace(refusing.id)).toMatchObject({ state: 'running', grantsRestored: [], needsAccess: ['openai'] });
    expect((await refusing.journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'needs_access', needsAccess: ['openai'] });
  });

  it('asks the gatekeeper only where there is something to ask, and never calls a failed read "granted"', async () => {
    const { journey, calls, id, manager, place } = await ready();
    const empty = await manager.createSpace({ placeId: 'memory', projectDirectory: PROJECT, name: 'No grants' });
    await place.stop(empty.id);
    calls.splice(0);
    // Not asked: no grants on the first, the second is stopped, and nobody asked for access.
    expect((await journey.listSpaces()).map((space) => space.access)).toEqual([null, null]);
    expect((await journey.listSpaces({ access: true })).map((space) => space.access)).toEqual([null, null]);
    expect(calls.filter(([name]) => name === 'readPolicy')).toEqual([]);

    await journey.grantAccess(id, anthropic);
    calls.splice(0);
    expect((await journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'granted' });
    expect(calls.filter(([name]) => name === 'readPolicy')).toEqual([['readPolicy', id]]);
    // A stopped space with grants is not asked either: its gatekeeper holds nothing and the next start says the grants again.
    await journey.stopSpace(id);
    expect((await journey.listSpaces({ access: true }))[0]).toMatchObject({ state: 'exited', access: null, grants: [expect.objectContaining({ id: 'anthropic' })] });

    const failing = await ready({ failAt: 'readPolicy' });
    await failing.journey.grantAccess(failing.id, anthropic);
    expect((await failing.journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'unknown', needsAccess: [] });
  });
});

describe('the journey: journal and apply', () => {
  const ready = async (options) => {
    const made = journeyWith(options);
    const { id } = await made.journey.createSpace(REQUEST);
    await until(() => steps(made.events, id).includes('ready'));
    await until(() => made.records.read(id).record?.history !== 'pending');
    made.calls.splice(0);
    return { ...made, id };
  };

  it('reads the journal of a running space and refuses one that is stopped, because the record is gone', async () => {
    const { journey, id, calls } = await ready();
    expect(await journey.readJournal(id)).toEqual({ records: [], dropped: 0, since: '2026-09-26T10:00:00.000Z' });
    expect(calls).toEqual([['readJournal', id]]);
    await journey.stopSpace(id);
    await expect(journey.readJournal(id)).rejects.toMatchObject({ code: 'space_not_running', message: expect.stringContaining('gone') });
    await expect(journey.readJournal('0f0f0f0f0f0f')).rejects.toMatchObject({ code: 'space_not_found' });
  });

  it('previews an apply by bringing the work out and describing the state, writing nothing', async () => {
    const { journey, id, calls } = await ready();
    const preview = await journey.previewApply(id);
    expect(preview).toMatchObject({ result: 'c'.repeat(40), changedPaths: 3, closed: false, newPaths: 3 });
    expect(calls).toEqual([
      ['bringCodeOut', { repository: PROJECT, spaceId: id, spacePath: `/spaces/${id}/project` }],
      ['describeApplyState', { repository: PROJECT, spaceId: id }],
    ]);
  });

  it('applies as a branch, then removes the space when asked, and only after the apply went through', async () => {
    const { journey, place, id, calls } = await ready();
    const outcome = await journey.applySpace(id, { as: 'branch', branch: 'space/fix-login', removeAfterwards: true });
    expect(outcome.applied).toEqual({ status: 'applied', branch: 'space/fix-login', commit: 'c'.repeat(40) });
    expect(outcome.removal).toMatchObject({ id, removed: true, refsRemoved: true });
    expect(calls.map(([name]) => name)).toEqual(['bringCodeOut', 'applyAsBranch', 'removeSpaceRefs']);
    expect(await place.list()).toEqual([]);
  });

  it('applies as changes and keeps the space when not asked to remove it', async () => {
    const { journey, place, id, calls } = await ready();
    const outcome = await journey.applySpace(id, { as: 'changes' });
    expect(outcome.applied).toEqual({ status: 'applied', appliedPaths: 3, remembered: true });
    expect(outcome.removal).toBeNull();
    expect(calls.map(([name]) => name)).toEqual(['bringCodeOut', 'applyAsChanges']);
    expect(await place.list()).toHaveLength(1);
  });

  it('does not remove the space when there was nothing to apply, or when the apply refused', async () => {
    const nothing = await ready({ failAt: 'nothing' });
    expect((await nothing.journey.applySpace(nothing.id, { as: 'changes', removeAfterwards: true })).removal).toBeNull();
    expect(await nothing.place.list()).toHaveLength(1);

    const refused = await ready({ failAt: 'applyAsChanges' });
    await expect(refused.journey.applySpace(refused.id, { as: 'changes', removeAfterwards: true })).rejects.toMatchObject({ code: 'applyAsChanges_failed' });
    expect(await refused.place.list()).toHaveLength(1);
  });

  it('runs one action per space at a time: a remove during an apply is refused as busy', async () => {
    const { journey, place, id, releaseCodeOut } = await ready({ holdCodeOut: true });
    const applying = journey.applySpace(id, { as: 'changes' });
    await sleep(20);
    await expect(journey.removeSpace(id)).rejects.toMatchObject({ code: 'space_busy' });
    await expect(journey.stopSpace(id)).rejects.toMatchObject({ code: 'space_busy' });
    await expect(journey.readJournal(id)).rejects.toMatchObject({ code: 'space_busy' });
    // Other spaces are not held up.
    const other = await journey.createSpace({ ...REQUEST, name: 'Other' });
    releaseCodeOut();
    expect((await applying).applied.status).toBe('applied');
    expect(await journey.removeSpace(id)).toMatchObject({ removed: true });
    expect((await place.list()).map((space) => space.id)).toEqual([other.id]);
  });

  it('refuses an apply it cannot place: a bad way, a space still being made, or a project no longer registered', async () => {
    const { journey, id, records, calls } = await ready();
    await expect(journey.applySpace(id, { as: 'merge' })).rejects.toMatchObject({ code: 'invalid_apply_request' });
    records.remove(id);
    // Without a record the registered project still says where the work goes.
    await journey.previewApply(id);
    expect(calls[0]).toEqual(['bringCodeOut', { repository: PROJECT, spaceId: id, spacePath: `/spaces/${id}/project` }]);

    const orphan = journeyWith({ projects: [] });
    const other = await orphan.manager.createSpace({ placeId: 'memory', projectDirectory: PROJECT, name: 'Orphan' });
    await expect(orphan.journey.previewApply(other.id)).rejects.toMatchObject({ code: 'project_not_registered' });
    expect((await orphan.journey.listSpaces())[0]).toMatchObject({ id: other.id, projectDirectory: null, directory: null });
  });
});

describe('the journey: idle stop', () => {
  const ready = async (options) => {
    const made = journeyWith(options);
    const { id } = await made.journey.createSpace(REQUEST);
    await until(() => steps(made.events, id).includes('ready'));
    await until(() => made.records.read(id).record?.history !== 'pending');
    made.calls.splice(0);
    return { ...made, id };
  };

  /** The place's own stops, recorded, and its list as an idle stop leaves it: the space exited, its gatekeeper running. */
  const idleStopped = (place, { gatekeeperRunning = true } = {}) => {
    const stops = [];
    const { list, stop } = place;
    let stray = gatekeeperRunning;
    place.list = async () => (await list()).map((space) => ({ ...space, state: 'exited', stoppedIdle: true, gatekeeperRunning: stray }));
    place.stop = async (spaceId) => { stops.push(spaceId); stray = false; return stop(spaceId); };
    return stops;
  };

  it('tells the server inside the setting when the space is made and at every start and restart', async () => {
    const { journey, id, idle } = await ready();
    expect(idle.writes).toEqual([[id, { enabled: true, hours: 4 }]]);
    idle.saved = { enabled: true, hours: 9 };
    await journey.stopSpace(id);
    await journey.startSpace(id);
    await journey.restartSpace(id);
    expect(idle.writes.slice(1)).toEqual([[id, { enabled: true, hours: 9 }], [id, { enabled: true, hours: 9 }]]);
  });

  it('makes and starts a space whose setting could not be written, because the setting guards nothing', async () => {
    const { journey, id, idle } = await ready({ failAt: 'writeIdleStop' });
    expect((await journey.listSpaces())[0]).toMatchObject({ id, state: 'running' });
    await journey.stopSpace(id);
    expect(await journey.startSpace(id)).toMatchObject({ id, state: 'running', networkRestored: true });
    expect(idle.writes).toEqual([]);
  });

  it('keeps a changed setting and tells every running space, and only the running ones', async () => {
    const { journey, id, idle } = await ready();
    const { id: other } = await journey.createSpace(REQUEST);
    await until(() => idle.writes.some(([spaceId]) => spaceId === other));
    await journey.stopSpace(other);
    idle.writes.splice(0);

    expect(await journey.changeIdleStop({ enabled: false, hours: 12 })).toEqual({ enabled: false, hours: 12 });
    expect(idle.saved).toEqual({ enabled: false, hours: 12 });
    expect(idle.writes).toEqual([[id, { enabled: false, hours: 12 }]]);
    expect(await journey.readIdleStopSetting()).toEqual({ enabled: false, hours: 12 });
  });

  it('applies changes one after the other, so a space ends with the last one', async () => {
    const { journey, id, idle } = await ready();
    idle.writes.splice(0);
    await Promise.all([1, 2, 3].map((hours) => journey.changeIdleStop({ enabled: true, hours })));
    expect(idle.writes).toEqual([1, 2, 3].map((hours) => [id, { enabled: true, hours }]));
    expect(idle.saved).toEqual({ enabled: true, hours: 3 });
  });

  it('refuses a setting outside the whole hours from 1 to 168, and keeps nothing of it', async () => {
    const { journey, idle } = await ready();
    for (const request of [{ enabled: true, hours: 0 }, { enabled: true, hours: 169 }, { enabled: true, hours: 1.5 }, { enabled: 'yes', hours: 4 }, { enabled: true }, { enabled: true, hours: 4, extra: 1 }, null]) {
      await expect(journey.changeIdleStop(request)).rejects.toMatchObject({ code: 'invalid_idle_stop' });
    }
    expect(idle.saved).toBeNull();
  });

  it('writes nothing to the spaces when the setting could not be kept', async () => {
    const { journey, idle } = await ready({ failAt: 'saveIdleStop' });
    idle.writes.splice(0);
    await expect(journey.changeIdleStop({ enabled: true, hours: 2 })).rejects.toMatchObject({ code: 'saveIdleStop_failed' });
    expect(idle.writes).toEqual([]);
  });

  it('lists a space that stopped itself as such, and stops the gatekeeper it left running once', async () => {
    const { journey, place, id } = await ready();
    const stops = idleStopped(place);
    expect((await journey.listSpaces())[0]).toMatchObject({ id, state: 'exited', stoppedIdle: true });
    expect(await until(() => stops.length === 1)).toBe(true);
    await journey.listSpaces();
    await sleep(20);
    expect(stops).toEqual([id]);
  });

  it('leaves a stopped space alone when its gatekeeper is down already, or while another action holds it', async () => {
    const quietSpace = await ready();
    const quietStops = idleStopped(quietSpace.place, { gatekeeperRunning: false });
    await quietSpace.journey.listSpaces();
    await sleep(20);
    expect(quietStops).toEqual([]);

    const held = await ready({ holdCodeOut: true });
    const heldStops = idleStopped(held.place);
    const apply = held.journey.previewApply(held.id);
    await held.journey.listSpaces();
    await sleep(20);
    expect(heldStops).toEqual([]);
    held.releaseCodeOut();
    await apply;
  });

  it('lets a start wait for a gatekeeper being stopped beside its space, rather than refusing it as busy', async () => {
    const { journey, place, id } = await ready();
    idleStopped(place);
    const order = [];
    const { stop, start } = place;
    let letGo = () => {};
    place.stop = (spaceId) => new Promise((resolve) => { letGo = resolve; }).then(() => stop(spaceId)).then(() => { order.push('gatekeeper stopped'); });
    place.start = async (spaceId) => { order.push('start'); return start(spaceId); };
    await journey.listSpaces();
    const started = journey.startSpace(id);
    await sleep(20);
    expect(order).toEqual([]);
    letGo();
    await expect(started).resolves.toMatchObject({ id, networkRestored: true });
    expect(order).toEqual(['gatekeeper stopped', 'start']);
  });

  it('gives a space made or started during a change the changed setting, never the one before it', async () => {
    const { journey, id, idle } = await ready({ holdIdleSave: true });
    await journey.stopSpace(id);
    idle.writes.splice(0);
    const change = journey.changeIdleStop({ enabled: true, hours: 9 });
    const started = journey.startSpace(id);
    await sleep(20);
    idle.release();
    await Promise.all([change, started]);
    expect(idle.writes.at(-1)).toEqual([id, { enabled: true, hours: 9 }]);
    expect(idle.writes.every(([, setting]) => setting.hours === 9)).toBe(true);
  });

  it('stops a gatekeeper left by an idle stop when the switch goes off, without counting its space as stopped', async () => {
    const { journey, place, id } = await ready();
    const stops = idleStopped(place);
    expect(await journey.stopAllSpaces()).toEqual({ stopped: [], stillRunning: [] });
    expect(stops).toEqual([id]);
  });
});
