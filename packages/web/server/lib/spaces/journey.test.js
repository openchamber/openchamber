// The journey over the memory place, with stand-ins for the gatekeeper channel, code in and code
// out that record what they were asked. What is under test is the order of the steps, what the
// host remembers, what it announces, and what a failure leaves.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { createSpaceJourney } from './journey.js';
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
const journeyWith = ({ failAt = null, place = createMemoryPlace(), projects = [PROJECT], historyStatus = 'sent', holdCodeIn = false, holdCodeOut = false } = {}) => {
  // With `holdCodeIn`, code in waits until the test lets it go, so a creation stays under way;
  // `holdCodeOut` does the same for the fetch of an apply.
  let releaseCodeIn = () => {};
  const codeInHeld = new Promise((resolve) => { releaseCodeIn = resolve; });
  let releaseCodeOut = () => {};
  const codeOutHeld = new Promise((resolve) => { releaseCodeOut = resolve; });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-journey-'));
  folders.push(dataDir);
  const calls = [];
  const events = [];
  const changes = { count: 0 };
  const fail = (step) => { if (failAt === step) throw new SpaceError(`${step}_failed`, `the stand-in for ${step} failed`); };
  const gatekeeper = {
    setNetwork: async (spaceId, network) => { calls.push(['setNetwork', spaceId, network]); fail('setNetwork'); },
    readJournal: async (spaceId) => { calls.push(['readJournal', spaceId]); return { records: [], dropped: 0, since: '2026-09-26T10:00:00.000Z' }; },
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
    manager, place, gatekeeper, codeIn, codeOut, records,
    listProjectDirectories: async () => projects,
    announce: (spaceId, payload) => { events.push({ spaceId, ...payload.properties }); },
    onSpacesChanged: () => { changes.count += 1; },
    logger: quiet,
    now: () => new Date('2026-09-26T10:00:00.000Z'),
  });
  return { journey, place, records, calls, events, changes, manager, releaseCodeIn, releaseCodeOut };
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
