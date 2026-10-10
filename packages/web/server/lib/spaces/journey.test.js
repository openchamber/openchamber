// The journey over the memory place, with stand-ins for the gatekeeper channel, code in and code
// out that record what they were asked. What is under test is the order of the steps, what the
// host remembers, what it announces, and what a failure leaves.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { createSpaceJourney } from './journey.js';
import { createLoginKeeper } from './login-keeper.js';
import { ROLE_GATEKEEPER, spaceResourceName } from './labels.js';
import { IMAGE_TIMEOUT } from './layout.js';
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
const journeyWith = ({ readHostLogin = null, failAt = null, place = createMemoryPlace(), projects = [PROJECT], historyStatus = 'sent', holdCodeIn = false, holdCodeOut = false, holdIdleSave = false, holdReady = false, holdLoginRow = false, hostEnvironment = {}, hostLogin = null, dataDir = null, archiveChats = null, logger = quiet } = {}) => {
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
  // With `holdReady`, the server inside reports ready only when the test lets it, so the login
  // row's repair after a start waits where a real server inside would still be starting.
  let releaseReady = () => {};
  const readyHeld = new Promise((resolve) => { releaseReady = resolve; });
  const serverInside = {
    writeToken: async (spaceId, token) => { calls.push(['writeToken', spaceId, token]); fail('writeToken'); },
    writeIdleStop: async (spaceId, setting) => { fail('writeIdleStop'); idle.writes.push([spaceId, setting]); },
    waitUntilReady: async (spaceId) => { fail('waitUntilReady'); if (holdReady) await readyHeld; calls.push(['waitUntilReady', spaceId]); },
  };
  const restartOpenCodeInside = async (spaceId) => { calls.push(['restartOpenCodeInside', spaceId]); fail('restartOpenCodeInside'); };
  // With `holdLoginRow`, a write or removal of the login row inside waits until the test lets it
  // go, so the repair after a start can be caught in the middle of its writing.
  let releaseLoginRow = () => {};
  const loginRowHeld = new Promise((resolve) => { releaseLoginRow = resolve; });
  const spaceOpenCode = {
    writeProviderConfig: async (spaceId, grants) => { calls.push(['writeProviderConfig', spaceId, grants]); fail('writeProviderConfig'); },
    writeLogin: async (spaceId, provider, login) => { calls.push(['writeLogin', spaceId, provider, login]); if (holdLoginRow) await loginRowHeld; fail('writeLogin'); },
    removeLogin: async (spaceId) => { calls.push(['removeLogin', spaceId]); if (holdLoginRow) await loginRowHeld; fail('removeLogin'); },
  };
  const codeIn = {
    bringCodeIn: async (request) => {
      calls.push(['bringCodeIn', request]);
      if (holdCodeIn) await codeInHeld;
      fail('bringCodeIn');
      return { spacePath: `/spaces/${request.spaceId}/project`, projectPath: `/spaces/${request.spaceId}/project`, base: BASE, identityCopied: { name: true, email: false } };
    },
    sendHistory: async (request) => { calls.push(['sendHistory', request]); fail('sendHistory'); return { status: historyStatus }; },
    removeSpaceRefs: async (request) => {
      calls.push(['removeSpaceRefs', request]);
      fail('removeSpaceRefs');
      if (failAt === 'projectFolderGone') throw new SpaceError('project_folder_missing', `${request.repository} does not exist, or is not a folder.`);
    },
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
    archiveChats,
    readHostSecret: (name) => hostEnvironment[name],
    readHostLogin: readHostLogin ?? (async (provider) => (hostLogin && provider === 'openai' ? hostLogin : null)),
    folderExists: async () => true,
    readIdleStop: async () => idle.saved ?? { enabled: true, hours: 4 },
    saveIdleStop: async (setting) => { if (holdIdleSave) await idleSaveHeld; fail('saveIdleStop'); idle.saved = setting; },
    announce: (spaceId, payload) => { events.push({ spaceId, ...payload.properties }); },
    onSpacesChanged: () => { changes.count += 1; },
    logger,
    now: () => new Date('2026-09-26T10:00:00.000Z'),
  });
  return { journey, place, records, calls, events, changes, manager, releaseCodeIn, releaseCodeOut, releaseReady, releaseLoginRow, gatekeeper, dataDir, idle };
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
    expect(await journey.removeSpace(id)).toEqual({ id, removed: true, refsRemoved: null, failures: [], chats: null });
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

describe('the journey: disk and clean-up', () => {
  const DISK = { imageBytes: 1_632_000_000, toolsBytes: 438_000_000, spacesBytes: 0, freeBytes: 1_632_000_000, freesImage: true };
  const placeWithDisk = (cleaned, pull = { pulling: false, pulls: 0, fail: null }) => ({
    ...createMemoryPlace(),
    readDisk: async () => ({ ...DISK, imagePulling: pull.pulling }),
    cleanUpDisk: async () => { cleaned.count += 1; return cleaned.outcome; },
    pullImage: async () => { pull.pulls += 1; if (pull.fail) throw pull.fail; },
    imagePulling: () => pull.pulling,
  });

  it('starts the image download and answers the disk at once; a clean-up waits for the download; a failed download is logged, not thrown', async () => {
    const warnings = [];
    const cleaned = { count: 0, outcome: { freedBytes: 0, kept: [], machine: { state: 'skipped' } } };
    const pull = { pulling: true, pulls: 0, fail: new SpaceError('image_pull_failed', 'Could not download the base image: no route to host.') };
    const { journey } = journeyWith({ place: placeWithDisk(cleaned, pull), logger: { warn: (line) => warnings.push(line) } });
    expect(await journey.pullImage('memory')).toEqual({ ...DISK, imagePulling: true });
    expect(pull.pulls).toBe(1);
    await expect(journey.pullImage('kubernetes')).rejects.toMatchObject({ code: 'place_not_found' });
    await expect(journey.cleanUpDisk('memory')).rejects.toMatchObject({ code: 'image_pulling' });
    expect(cleaned.count).toBe(0);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(warnings).toEqual(['[spaces] the image download failed: image_pull_failed']);
  });

  it('answers what was freed and the disk after, keeps Docker\'s words out of the answer and logs them', async () => {
    const warnings = [];
    const cleaned = {
      count: 0,
      outcome: {
        freedBytes: 440_000_000,
        kept: [{ kind: 'image', name: 'node@sha256:0', reason: 'in_use', message: 'image is being used' }, { kind: 'tools', name: 'openchamber-tools-x', reason: 'failed', message: 'disk on fire' }],
        machine: { state: 'failed', message: 'sudo: a password is required' },
      },
    };
    const { journey } = journeyWith({ place: placeWithDisk(cleaned), logger: { warn: (line) => warnings.push(line) } });
    expect(await journey.readDisk('memory')).toEqual({ ...DISK, imagePulling: false });
    expect(await journey.cleanUpDisk('memory')).toEqual({ freedBytes: 440_000_000, kept: [{ kind: 'image', reason: 'in_use' }, { kind: 'tools', reason: 'failed' }], disk: { ...DISK, imagePulling: false } });
    expect(warnings).toEqual([
      '[spaces] clean-up could not remove tools openchamber-tools-x: disk on fire',
      '[spaces] the Colima machine did not trim its disk: sudo: a password is required',
    ]);
  });

  it('refuses an unknown place, and a clean-up while a space is being made', async () => {
    const cleaned = { count: 0, outcome: { freedBytes: 0, kept: [], machine: { state: 'skipped' } } };
    const { journey, events, releaseCodeIn } = journeyWith({ place: placeWithDisk(cleaned), holdCodeIn: true });
    await expect(journey.readDisk('kubernetes')).rejects.toMatchObject({ code: 'place_not_found' });
    await expect(journey.cleanUpDisk('kubernetes')).rejects.toMatchObject({ code: 'place_not_found' });
    const { id } = await journey.createSpace(REQUEST);
    expect(await until(() => steps(events, id).includes('bringing_code'))).toBe(true);
    await expect(journey.cleanUpDisk('memory')).rejects.toMatchObject({ code: 'space_preparing' });
    expect(cleaned.count).toBe(0);
    releaseCodeIn();
    expect(await until(() => steps(events, id).includes('ready'))).toBe(true);
    await journey.cleanUpDisk('memory');
    expect(cleaned.count).toBe(1);
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

  it('lists a space whose code never arrived as a failed creation, which Remove takes away', async () => {
    // A host that quit in the middle of bringing the code in leaves the containers running and
    // the record without a space path. The next host must not list that as a healthy space.
    const { journey, records, place, id } = await ready();
    records.update(id, { spacePath: null, base: null });
    expect((await journey.listSpaces())[0]).toMatchObject({ id, state: 'failed', step: 'failed', failure: { code: 'space_code_never_arrived', message: expect.stringContaining('closed before the code arrived'), details: null } });
    expect(await journey.removeSpace(id)).toMatchObject({ id, removed: true, refsRemoved: true, failures: [] });
    expect(await place.list()).toEqual([]);
    expect(records.read(id)).toEqual({ status: 'missing', record: null });
  });

  it('removes the space, the refs in the user\'s repository and the record', async () => {
    const { journey, place, records, calls, id } = await ready();
    expect(await journey.removeSpace(id)).toEqual({ id, removed: true, refsRemoved: true, failures: [], chats: null });
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

  it('counts a delete as done when the project folder is gone and its refs with it', async () => {
    const { journey, place, records, id } = await ready({ failAt: 'projectFolderGone' });
    expect(await journey.removeSpace(id)).toEqual({ id, removed: true, refsRemoved: false, failures: [], chats: null });
    expect(await place.list()).toEqual([]);
    expect(records.read(id).status).toBe('missing');
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

  describe('the host\'s own login', () => {
    const ACCESS = 'eyJ-live-short-token-of-the-host';
    const login = { kind: 'login', provider: 'openai' };
    const tokenSharing = { methodID: 'chatgpt-token-sharing', access: ACCESS, expires: Date.parse('2026-09-26T11:00:00.000Z'), metadata: { clientID: 'client_1', scopes: ['chatgpt.tokens.use.direct'], models: [{ slug: 'gpt-5.5' }] } };
    const legacy = { methodID: 'chatgpt-browser', access: ACCESS, expires: Date.parse('2026-09-26T11:00:00.000Z'), metadata: { accountID: 'acct_1' } };

    it('gives the login\'s short token to the gatekeeper at the method\'s upstream, remembers only the method, and writes the row and the configuration inside', async () => {
      const { journey, calls, records, dataDir, id } = await ready({ hostLogin: tokenSharing });
      const granted = await journey.grantAccess(id, login);
      expect(granted).toEqual({ grant: { kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing', url: 'http://gatekeeper:8080/model/openai' } });
      expect(calls).toEqual([
        ['addGrant', id, { id: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', secret: ACCESS }],
        ['writeProviderConfig', id, [{ kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing' }]],
        ['writeLogin', id, 'openai', tokenSharing],
      ]);
      // The token is in the gatekeeper's call and nowhere the host keeps.
      expect(JSON.stringify(granted)).not.toContain(ACCESS);
      expect(fs.readFileSync(path.join(dataDir, 'spaces', 'records', `${id}.json`), 'utf8')).not.toContain(ACCESS);
      expect(records.read(id).record.grants).toEqual([{ kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing' }]);
      expect((await journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'granted', grants: [expect.objectContaining({ kind: 'login', id: 'openai' })] });
    });

    it('sends the legacy ChatGPT login to its own upstream', async () => {
      const { journey, calls, id } = await ready({ hostLogin: legacy });
      await journey.grantAccess(id, login);
      expect(calls[0]).toEqual(['addGrant', id, { id: 'openai', upstream: 'https://chatgpt.com/backend-api/codex', header: 'authorization', secret: ACCESS }]);
      expect(calls[2]).toEqual(['writeLogin', id, 'openai', legacy]);
    });

    it('refuses when the host has no such login, one made another way, or one that has run out, and a request that names no provider', async () => {
      const none = await ready();
      await expect(none.journey.grantAccess(none.id, login)).rejects.toMatchObject({ code: 'login_not_found' });
      const other = await ready({ hostLogin: { ...tokenSharing, methodID: 'some-new-method' } });
      await expect(other.journey.grantAccess(other.id, login)).rejects.toMatchObject({ code: 'login_not_supported', message: expect.stringContaining('some-new-method') });
      const ended = await ready({ hostLogin: { ...tokenSharing, expires: Date.parse('2026-09-26T09:59:00.000Z') } });
      await expect(ended.journey.grantAccess(ended.id, login)).rejects.toMatchObject({ code: 'login_expired' });
      await expect(ended.journey.grantAccess(ended.id, { kind: 'login' })).rejects.toMatchObject({ code: 'invalid_grant_request' });
      await expect(ended.journey.grantAccess(ended.id, { kind: 'login', provider: 'openai', access: ACCESS })).rejects.toMatchObject({ code: 'invalid_grant_request' });
      for (const made of [none, other, ended]) {
        expect(made.calls).toEqual([]);
        expect(made.records.read(made.id).record.grants).toEqual([]);
      }
    });

    it('tells the dialogs which logins the host has, without the token: usable, run out, made another way, or none', async () => {
      const usable = await ready({ hostLogin: tokenSharing });
      expect(await usable.journey.readHostLogins()).toEqual({ logins: [{ provider: 'openai', method: 'chatgpt-token-sharing', expires: '2026-09-26T11:00:00.000Z', state: 'usable' }] });
      expect(JSON.stringify(await usable.journey.readHostLogins())).not.toContain(ACCESS);
      const ended = await ready({ hostLogin: { ...tokenSharing, expires: Date.parse('2026-09-26T09:59:00.000Z') } });
      expect(await ended.journey.readHostLogins()).toEqual({ logins: [expect.objectContaining({ provider: 'openai', state: 'expired' })] });
      const other = await ready({ hostLogin: { ...legacy, methodID: 'some-new-method' } });
      expect(await other.journey.readHostLogins()).toEqual({ logins: [expect.objectContaining({ provider: 'openai', method: 'some-new-method', state: 'unsupported' })] });
      const none = await ready();
      expect(await none.journey.readHostLogins()).toEqual({ logins: [] });
      // A host whose OpenCode cannot be asked is a failure, never "signed out".
      const broken = journeyWith({ readHostLogin: async () => { throw new Error('OpenCode is not connected yet'); } });
      await expect(broken.journey.readHostLogins()).rejects.toThrow('OpenCode is not connected yet');
    });

    it('replaces a key with the login and the login with a key, taking the row inside with the login', async () => {
      const { journey, calls, records, id } = await ready({ hostLogin: tokenSharing, hostEnvironment: { OPENAI_API_KEY: ENV_KEY } });
      await journey.grantAccess(id, openai);
      await journey.grantAccess(id, login);
      expect(records.read(id).record.grants).toEqual([{ kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing' }]);
      expect(calls.filter(([name]) => name === 'removeLogin')).toEqual([]);
      calls.splice(0);
      await journey.grantAccess(id, openai);
      expect(records.read(id).record.grants).toEqual([expect.objectContaining({ kind: 'model', id: 'openai' })]);
      // The row goes first: a removal that fails leaves the login grant as it was.
      expect(calls.map(([name]) => name)).toEqual(['removeLogin', 'addGrant', 'writeProviderConfig']);
      const stuck = await ready({ hostLogin: tokenSharing, hostEnvironment: { OPENAI_API_KEY: ENV_KEY }, failAt: 'removeLogin' });
      await stuck.journey.grantAccess(stuck.id, login);
      stuck.calls.splice(0);
      await expect(stuck.journey.grantAccess(stuck.id, openai)).rejects.toMatchObject({ code: 'removeLogin_failed' });
      expect(stuck.calls.map(([name]) => name)).toEqual(['removeLogin']);
      expect(stuck.records.read(stuck.id).record.grants).toEqual([expect.objectContaining({ kind: 'login' })]);
    });

    it('keeps the grant when the row inside could not be written, so a grant said again repairs it', async () => {
      const failing = await ready({ hostLogin: tokenSharing, failAt: 'writeLogin' });
      await expect(failing.journey.grantAccess(failing.id, login)).rejects.toMatchObject({ code: 'writeLogin_failed' });
      expect(failing.records.read(failing.id).record.grants).toEqual([expect.objectContaining({ kind: 'login', id: 'openai' })]);
    });

    it('says the login again after a start from the host\'s login as it is then: the same method yes; no login, another method or an ended token no', async () => {
      const made = await ready({ hostLogin: tokenSharing });
      await made.journey.grantAccess(made.id, login);
      await made.journey.stopSpace(made.id);
      made.gatekeeper.forget(made.id);
      made.calls.splice(0);
      expect(await made.journey.startSpace(made.id)).toMatchObject({ grantsRestored: ['openai'], needsAccess: [] });
      expect(made.calls.filter(([name]) => name === 'addGrant')).toEqual([['addGrant', made.id, { id: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', secret: ACCESS }]]);
      // The configuration is written again from the record, and the row inside in the background
      // once the server inside answers, so a write that failed at the grant is repaired here.
      expect(made.calls.filter(([name]) => name === 'writeProviderConfig')).toEqual([['writeProviderConfig', made.id, [expect.objectContaining({ kind: 'login' })]]]);
      await until(() => made.calls.some(([name]) => name === 'writeLogin'));
      expect(made.calls.filter(([name]) => name === 'waitUntilReady' || name === 'writeLogin')).toEqual([['waitUntilReady', made.id], ['writeLogin', made.id, 'openai', tokenSharing]]);

      for (const hostLogin of [null, legacy, { ...tokenSharing, expires: Date.parse('2026-09-26T09:59:00.000Z') }]) {
        await made.journey.stopSpace(made.id);
        made.gatekeeper.forget(made.id);
        const then = journeyWith({ place: made.place, dataDir: made.dataDir, hostLogin });
        expect(await then.journey.startSpace(made.id)).toMatchObject({ grantsRestored: [], needsAccess: ['openai'] });
        expect(then.calls.filter(([name]) => name === 'addGrant')).toEqual([]);
        expect((await then.journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'needs_access', needsAccess: ['openai'] });
        // The row inside is taken out: a login the host cannot say is not one the space should hold.
        await until(() => then.calls.some(([name]) => name === 'removeLogin'));
        expect(then.calls.filter(([name]) => name === 'writeLogin')).toEqual([]);
      }
    });

    it('takes a row out at a start when a key replaced the login but the removal failed, and goes on when the server inside never answers', async () => {
      const made = await ready({ hostLogin: tokenSharing, hostEnvironment: { OPENAI_API_KEY: ENV_KEY } });
      await made.journey.grantAccess(made.id, openai);
      await made.journey.stopSpace(made.id);
      made.calls.splice(0);
      await made.journey.startSpace(made.id);
      await until(() => made.calls.some(([name]) => name === 'removeLogin'));
      expect(made.calls.filter(([name]) => name === 'writeLogin')).toEqual([]);

      // A key granted while the server inside is still starting wins: the repair decides from the
      // record as it is when the server answers, so it takes the row out and writes none back.
      const racing = await ready({ hostLogin: tokenSharing, hostEnvironment: { OPENAI_API_KEY: ENV_KEY }, holdReady: true });
      await racing.journey.grantAccess(racing.id, login);
      await racing.journey.stopSpace(racing.id);
      await racing.journey.startSpace(racing.id);
      racing.calls.splice(0);
      await racing.journey.grantAccess(racing.id, openai);
      racing.releaseReady();
      await until(() => racing.calls.filter(([name]) => name === 'removeLogin').length === 2);
      expect(racing.calls.map(([name]) => name)).toEqual(['removeLogin', 'addGrant', 'writeProviderConfig', 'waitUntilReady', 'removeLogin']);
      expect(racing.records.read(racing.id).record.grants).toEqual([expect.objectContaining({ kind: 'model', id: 'openai' })]);

      // A key granted while the repair is writing the login row waits for that write and then
      // takes the row out, so the two never cross; the space is not "busy" for it.
      const writing = await ready({ hostLogin: tokenSharing, hostEnvironment: { OPENAI_API_KEY: ENV_KEY }, holdLoginRow: true });
      const first = writing.journey.grantAccess(writing.id, login);
      writing.releaseLoginRow();
      await first;
      await writing.journey.stopSpace(writing.id);
      writing.calls.splice(0);
      const held = journeyWith({ place: writing.place, dataDir: writing.dataDir, hostLogin: tokenSharing, hostEnvironment: { OPENAI_API_KEY: ENV_KEY }, holdLoginRow: true });
      await held.journey.startSpace(writing.id);
      await until(() => held.calls.some(([name]) => name === 'writeLogin'));
      held.calls.splice(0);
      const granting = held.journey.grantAccess(writing.id, openai);
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      expect(held.calls).toEqual([]);
      held.releaseLoginRow();
      await granting;
      expect(held.calls.map(([name]) => name)).toEqual(['removeLogin', 'addGrant', 'writeProviderConfig']);

      const silent = await ready({ hostLogin: tokenSharing, failAt: 'waitUntilReady' });
      await silent.journey.grantAccess(silent.id, login);
      await silent.journey.stopSpace(silent.id);
      silent.calls.splice(0);
      expect(await silent.journey.startSpace(silent.id)).toMatchObject({ state: 'running', grantsRestored: ['openai'] });
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      expect(silent.calls.filter(([name]) => name === 'writeLogin' || name === 'removeLogin')).toEqual([]);
    });

    it('refuses an ended login the issuer would not renew as expired, read through the real keeper', async () => {
      const ended = { ...tokenSharing, expires: Date.parse('2026-09-26T09:59:00.000Z') };
      const keeper = createLoginKeeper({
        readLogin: async (provider) => (provider === 'openai' ? ended : null),
        renewLogin: async () => { throw Object.assign(new Error('The login issuer answered 401'), { code: 'login_refused' }); },
        exchange: async () => ({}),
        holders: async () => [],
        say: async () => true,
        now: () => Date.parse('2026-09-26T10:00:00.000Z'),
        logger: quiet,
      });
      const made = await ready({ readHostLogin: keeper.fresh });
      await expect(made.journey.grantAccess(made.id, login)).rejects.toMatchObject({ code: 'login_expired', message: expect.stringContaining('could not be renewed') });
      expect(made.records.read(made.id).record.grants).toEqual([]);
    });

    it('says the login again for the keeper, the same window grant replaced, and leaves a space with an action under way to it', async () => {
      const { journey, calls, id, releaseCodeOut } = await ready({ hostLogin: tokenSharing, holdCodeOut: true });
      const grant = { kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing' };
      const renewed = { ...tokenSharing, access: 'eyJ-renewed', expires: Date.parse('2026-09-26T12:00:00.000Z') };
      await expect(journey.sayLogin(id, grant, renewed)).resolves.toBe(true);
      expect(calls).toEqual([['addGrant', id, { id: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', secret: 'eyJ-renewed' }]]);
      calls.splice(0);
      const preview = journey.previewApply(id);
      await expect(journey.sayLogin(id, grant, renewed)).resolves.toBeNull();
      expect(calls.filter(([name]) => name === 'addGrant')).toEqual([]);
      releaseCodeOut();
      await preview;
      const refusing = await ready({ hostLogin: tokenSharing, failAt: 'addGrant' });
      await expect(refusing.journey.sayLogin(refusing.id, grant, renewed)).resolves.toBe(false);
    });

    it('says a login a running gatekeeper lost again when the host starts', async () => {
      const { journey, calls, gatekeeper, id } = await ready({ hostLogin: tokenSharing });
      await journey.grantAccess(id, login);
      gatekeeper.forget(id);
      calls.splice(0);
      await journey.restoreLostGrants();
      expect(calls.filter(([name]) => name === 'addGrant')).toEqual([['addGrant', id, { id: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', secret: ACCESS }]]);
      expect((await journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'granted' });
    });
  });

  it('says the grants a running gatekeeper lost again when the host starts: an environment key and a domain, never a typed key', async () => {
    const { journey, calls, gatekeeper, id, changes } = await ready({ hostEnvironment: { OPENAI_API_KEY: ENV_KEY } });
    await journey.grantAccess(id, anthropic);
    await journey.grantAccess(id, openai);
    const opened = await journey.grantAccess(id, registry);
    // The gatekeeper lost everything, as after a start the previous host did not live to finish; the space runs on.
    gatekeeper.forget(id);
    expect((await journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'needs_access', needsAccess: ['anthropic', 'openai', opened.grant.id] });
    calls.splice(0);
    const before = changes.count;

    await journey.restoreLostGrants();
    expect(calls.filter(([name]) => name === 'addGrant')).toEqual([
      ['addGrant', id, { id: 'openai', upstream: 'https://api.openai.com/v1', header: 'authorization', secret: ENV_KEY }],
      ['addGrant', id, { id: opened.grant.id, upstream: 'https://registry.example.com/npm/', header: null, secret: null }],
    ]);
    expect(JSON.stringify(calls)).not.toContain(KEY);
    expect(changes.count).toBe(before + 1);
    // Only the typed key still needs the user.
    expect((await journey.listSpaces({ access: true }))[0]).toMatchObject({ access: 'needs_access', needsAccess: ['anthropic'] });

    // A gatekeeper that holds its grants is asked and told nothing.
    calls.splice(0);
    await journey.restoreLostGrants();
    expect(calls.map(([name]) => name)).toEqual(['readPolicy']);
  });

  it('leaves a stopped space, a space without grants and a gatekeeper that does not answer alone when the host starts', async () => {
    const { journey, calls, gatekeeper, id, manager, place } = await ready({ hostEnvironment: { OPENAI_API_KEY: ENV_KEY } });
    await journey.grantAccess(id, openai);
    const empty = await manager.createSpace({ placeId: 'memory', projectDirectory: PROJECT, name: 'No grants' });
    gatekeeper.forget(id);
    gatekeeper.readPolicy = async () => { throw new SpaceError('gatekeeper_unreachable', 'the gatekeeper did not answer'); };
    calls.splice(0);
    await journey.restoreLostGrants();
    expect(calls.filter(([name]) => name === 'addGrant')).toEqual([]);

    await place.stop(id);
    await place.stop(empty.id);
    calls.splice(0);
    await journey.restoreLostGrants();
    expect(calls).toEqual([]);
  });

  it('leaves a space with an action under way to that action when the host starts', async () => {
    const { journey, calls, gatekeeper, id, releaseCodeOut } = await ready({ hostEnvironment: { OPENAI_API_KEY: ENV_KEY }, holdCodeOut: true });
    await journey.grantAccess(id, openai);
    gatekeeper.forget(id);
    const preview = journey.previewApply(id);
    calls.splice(0);
    await journey.restoreLostGrants();
    expect(calls.filter(([name]) => name === 'readPolicy' || name === 'addGrant')).toEqual([]);
    releaseCodeOut();
    await preview;
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

  it('refuses to preview or apply a stopped space with its own code, before reaching into it', async () => {
    const { journey, id, calls } = await ready();
    await journey.stopSpace(id);
    calls.splice(0);
    await expect(journey.previewApply(id)).rejects.toMatchObject({ code: 'space_not_running' });
    await expect(journey.applySpace(id, { as: 'changes' })).rejects.toMatchObject({ code: 'space_not_running' });
    expect(calls).toEqual([]);
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
    expect((await orphan.journey.listSpaces())[0]).toMatchObject({ id: other.id, projectDirectory: null, directory: null, projectFolder: { path: null, found: null } });
  });
});

describe('the journey: the project folder of a space', () => {
  const made = async () => {
    const first = journeyWith();
    const { id } = await first.journey.createSpace(REQUEST);
    await until(() => steps(first.events, id).includes('ready'));
    await until(() => first.records.read(id).record?.history !== 'pending');
    return { id, first };
  };

  it('names the folder the space was made for and whether it is there, while the project is registered and after it is gone', async () => {
    const { id, first } = await made();
    const asked = [];
    // The record names the folder: a journey that no longer has the project still lists it.
    const unregistered = createSpaceJourney({
      manager: first.manager, place: first.place, gatekeeper: first.gatekeeper, codeIn: {}, codeOut: {}, records: first.records,
      spaceOpenCode: {}, serverInside: {}, restartOpenCodeInside: async () => {},
      listProjectDirectories: async () => [],
      folderExists: async (directory) => { asked.push(directory); return false; },
      logger: quiet,
    });
    expect((await unregistered.listSpaces())[0]).toMatchObject({ id, projectDirectory: null, directory: null, projectFolder: { path: PROJECT, found: false } });
    expect(asked).toEqual([PROJECT]);
  });

  it('says the folder is there by looking at the host', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-journey-project-'));
    folders.push(folder);
    const file = path.join(folder, 'a-file');
    fs.writeFileSync(file, '');
    const { first } = await made();
    const look = (directory) => createSpaceJourney({
      manager: first.manager, place: first.place, gatekeeper: first.gatekeeper, codeIn: {}, codeOut: {}, records: { read: () => ({ record: { repository: directory } }) },
      spaceOpenCode: {}, serverInside: {}, restartOpenCodeInside: async () => {},
      listProjectDirectories: async () => [],
      logger: quiet,
    }).listSpaces();
    expect((await look(folder))[0].projectFolder).toEqual({ path: folder, found: true });
    // A file where the folder was is not the folder, and neither is nothing.
    expect((await look(file))[0].projectFolder).toEqual({ path: file, found: false });
    expect((await look(path.join(folder, 'gone')))[0].projectFolder).toEqual({ path: path.join(folder, 'gone'), found: false });
  });

  it('lists a creation under way with its folder not looked at yet', async () => {
    const { journey } = journeyWith({ holdCodeIn: true });
    const { id } = await journey.createSpace(REQUEST);
    expect((await journey.listSpaces()).find((space) => space.id === id)).toMatchObject({ projectFolder: { path: PROJECT, found: null } });
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
    // The preview takes the lock while the space still runs; the idle stop comes during it.
    const apply = held.journey.previewApply(held.id);
    const heldStops = idleStopped(held.place);
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

describe('the journey: setup commands', () => {
  /** A memory place whose space answers the setup commands from `answers`, by the command, and holds the named one. */
  const setupPlace = (answers = {}) => {
    const place = createMemoryPlace();
    const exec = place.exec;
    const ran = [];
    let release = () => {};
    const held = new Promise((resolve) => { release = resolve; });
    place.exec = async (spaceId, argv, options) => {
      if (argv[0] !== IMAGE_TIMEOUT) return exec(spaceId, argv, options);
      const command = argv.at(-1);
      ran.push({ spaceId, cwd: argv.at(-2), command });
      if (command === 'hold') await held;
      return answers[command] ?? { code: 0, stdout: '', stderr: '' };
    };
    return { place, ran, release: () => release() };
  };
  const setupEvents = (events, spaceId) => events.filter((event) => event.spaceId === spaceId && event.step === undefined);

  it('runs the setup commands in the project inside once the space is ready, and lists how they went', async () => {
    const { place, ran } = setupPlace({ 'npm ci': { code: 1, stdout: 'npm ERR! 403 Forbidden\n', stderr: '' } });
    const { journey, events } = journeyWith({ place });
    const answer = await journey.createSpace({ ...REQUEST, setupCommands: ['echo hi', 'npm ci', '  ', 'npm run build'] });
    // The answer says a setup will run, so the client knows to wait for it when the project asks.
    expect(answer.setup).toEqual({ state: 'queued', total: 3 });
    const { id } = answer;
    expect(await until(() => ran.length === 2)).toBe(true);
    expect(await until(() => journey.listSpaces().then((spaces) => spaces[0].setup?.state === 'failed'))).toBe(true);
    expect(ran).toEqual([{ spaceId: id, cwd: `/spaces/${id}/project`, command: 'echo hi' }, { spaceId: id, cwd: `/spaces/${id}/project`, command: 'npm ci' }]);
    // Only after the space was ready: the agent can already start.
    const mine = events.filter((event) => event.spaceId === id);
    expect(mine.findIndex((event) => event.step === 'ready')).toBeLessThan(mine.findIndex((event) => event.step === undefined));
    const listed = (await journey.listSpaces()).find((space) => space.id === id);
    expect(listed.setup).toEqual({ state: 'failed', index: 1, total: 3, command: 'npm ci', exitCode: 1, timedOut: false, startedAt: '2026-09-26T10:00:00.000Z', finishedAt: '2026-09-26T10:00:00.000Z' });
    expect(await journey.readSetup(id)).toEqual({ setup: listed.setup, output: 'npm ERR! 403 Forbidden' });
    expect(setupEvents(events, id).length).toBeGreaterThanOrEqual(2);
  });

  it('runs nothing and lists no setup for a project without setup commands', async () => {
    const { place, ran } = setupPlace();
    const { journey, events } = journeyWith({ place });
    const { id, setup } = await journey.createSpace(REQUEST);
    expect(setup).toBeNull();
    expect(await until(() => steps(events, id).includes('ready'))).toBe(true);
    expect(ran).toEqual([]);
    expect((await journey.listSpaces()).find((space) => space.id === id).setup).toBeNull();
    expect(await journey.readSetup(id)).toEqual({ setup: null, output: null });
  });

  it('refuses a list of setup commands the host would not keep, and makes no space for it', async () => {
    const { journey, place } = journeyWith();
    await expect(journey.createSpace({ ...REQUEST, setupCommands: 'npm ci' })).rejects.toMatchObject({ code: 'invalid_setup_commands' });
    await expect(journey.createSpace({ ...REQUEST, setupCommands: Array.from({ length: 101 }, () => 'true') })).rejects.toMatchObject({ code: 'invalid_setup_commands' });
    expect(await place.list()).toEqual([]);
  });

  it('runs them again in a running space when asked, once at a time, and never in a stopped one', async () => {
    const { place, ran, release } = setupPlace();
    const { journey, events } = journeyWith({ place });
    const { id } = await journey.createSpace(REQUEST);
    expect(await until(() => steps(events, id).includes('ready'))).toBe(true);

    const answer = await journey.runSetup(id, { commands: ['hold', 'npm ci'] });
    expect(answer.setup).toEqual({ state: 'running', index: 0, total: 2, command: 'hold' });
    await expect(journey.runSetup(id, { commands: ['npm ci'] })).rejects.toMatchObject({ code: 'space_setup_running' });
    release();
    expect(await until(() => ran.length === 2)).toBe(true);
    expect(await until(() => journey.listSpaces().then((spaces) => spaces[0].setup?.state === 'done'))).toBe(true);

    await expect(journey.runSetup(id, { commands: [] })).rejects.toMatchObject({ code: 'invalid_setup_commands' });
    await expect(journey.runSetup(id, {})).rejects.toMatchObject({ code: 'invalid_setup_commands' });
    await journey.stopSpace(id);
    await expect(journey.runSetup(id, { commands: ['npm ci'] })).rejects.toMatchObject({ code: 'space_not_running' });
    expect(ran).toHaveLength(2);
  });

  it('lists a run that a restart of the host cut off as interrupted', async () => {
    const { place } = setupPlace();
    const first = journeyWith({ place });
    const { id } = await first.journey.createSpace(REQUEST);
    expect(await until(() => steps(first.events, id).includes('ready'))).toBe(true);
    first.records.update(id, { setup: { state: 'running', total: 2, startedAt: '2026-09-26T09:00:00.000Z' } });
    // Another process on the same data: it has no run in its memory.
    const second = journeyWith({ place, dataDir: first.dataDir });
    expect((await second.journey.listSpaces()).find((space) => space.id === id).setup).toEqual({ state: 'interrupted', total: 2 });
  });
});

describe('the journey: the chat archive of a deleted space', () => {
  // A stand-in archive that records what it was asked and the state of the space at that moment.
  const archiveWith = (place, answer) => {
    const asked = [];
    const archiveChats = async (request) => {
      asked.push({ ...request, stateThen: (await place.list()).find((space) => space.id === request.spaceId)?.state });
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { asked, archiveChats };
  };
  const ready = async (answer = { saved: 2, tooLarge: [], failed: 0, listed: true }) => {
    const place = createMemoryPlace();
    const archive = archiveWith(place, answer);
    const made = journeyWith({ place, archiveChats: archive.archiveChats });
    const { id } = await made.journey.createSpace(REQUEST);
    await until(() => steps(made.events, id).includes('ready'));
    await until(() => made.records.read(id).record?.history !== 'pending');
    made.calls.splice(0);
    return { ...made, ...archive, id };
  };
  const notSaved = () => new SpaceError('chats_not_saved', 'The chats of "Fix login" could not be saved.', { name: 'Fix login', tooLarge: ['Big one'], failed: 0, listed: true });

  it('does not ask the archive for a space whose code never arrived, and removes it', async () => {
    const { journey, place, records, asked, id } = await ready();
    records.update(id, { spacePath: null, base: null });
    expect(await journey.removeSpace(id)).toMatchObject({ id, removed: true, refsRemoved: true, failures: [], chats: null });
    expect(asked).toEqual([]);
    expect(await place.list()).toEqual([]);
  });

  it('saves the chats of a running space before it goes, and says how many', async () => {
    const { journey, place, asked, calls, id } = await ready();
    const outcome = await journey.removeSpace(id);
    expect(asked).toEqual([{ spaceId: id, name: 'Fix login', projectDirectory: PROJECT, running: true, allowUnsaved: false, stateThen: 'running' }]);
    expect(outcome).toEqual({ id, removed: true, refsRemoved: true, failures: [], chats: { saved: 2, tooLarge: [], failed: 0, listed: true } });
    expect(calls.map(([name]) => name)).toEqual(['removeSpaceRefs']);
    expect(await place.list()).toEqual([]);
  });

  it('starts a stopped space to take its chats', async () => {
    const { journey, asked, id } = await ready();
    await journey.stopSpace(id);
    await journey.removeSpace(id);
    expect(asked).toEqual([expect.objectContaining({ running: true, stateThen: 'running' })]);
  });

  it('deletes nothing when the chats cannot all be saved, and deletes anyway when the user says so', async () => {
    const { journey, place, records, calls, asked, id } = await ready(notSaved());
    await expect(journey.removeSpace(id)).rejects.toMatchObject({ code: 'chats_not_saved', details: { tooLarge: ['Big one'] } });
    expect(await place.list()).toEqual([expect.objectContaining({ id })]);
    expect(records.read(id).status).toBe('ok');
    expect(calls).toEqual([]);
    await expect(journey.removeSpace(id, { allowUnsaved: true })).rejects.toMatchObject({ code: 'chats_not_saved' });
    expect(asked.map((request) => request.allowUnsaved)).toEqual([false, true]);
  });

  it('stops a stopped space again when it was started for its chats and they could not be saved', async () => {
    const { journey, place, id } = await ready(notSaved());
    await journey.stopSpace(id);
    await expect(journey.removeSpace(id)).rejects.toMatchObject({ code: 'chats_not_saved' });
    expect((await place.list()).find((space) => space.id === id)?.state).toBe('exited');
  });

  it('keeps a space asked to go after an apply when its chats cannot be saved, with the work applied', async () => {
    const { journey, place, id } = await ready(notSaved());
    const outcome = await journey.applySpace(id, { as: 'branch', branch: 'space/fix-login', removeAfterwards: true });
    expect(outcome.applied).toMatchObject({ status: 'applied', branch: 'space/fix-login' });
    expect(outcome.removal).toBeNull();
    expect(outcome.kept).toMatchObject({ code: 'chats_not_saved' });
    expect(await place.list()).toEqual([expect.objectContaining({ id })]);
  });
});
