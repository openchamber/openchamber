// The routes over a stand-in journey: the shapes, the statuses per refusal, and the switch.

import http from 'node:http';

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { SpaceError } from './errors.js';
import { SPACES_ROUTE, answerFailure, createSwitchController, registerSpaceRoutes } from './routes.js';

const ID = 'a1b2c3d4e5f6';
const servers = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(() => resolve()));
});

/** An app with the routes over `journey`, or with the feature off when `journey` is null. */
const serve = async ({ journey, places = [], switchState = { enabled: true }, machinePlace = null, dockerSetup = null } = {}) => {
  const app = express();
  app.use(express.json());
  const calls = [];
  const state = { journey, enabled: switchState.enabled };
  registerSpaceRoutes(app, {
    getJourney: () => state.journey,
    getPlaces: () => places,
    getDockerSetup: () => (dockerSetup && state.journey ? { placeId: 'docker', setup: dockerSetup } : null),
    readSwitch: async () => ({ enabled: state.enabled, spaces: state.enabled ? [{ id: ID, name: 'One', state: 'running' }] : [] }),
    setSwitch: async (enabled) => {
      calls.push(['setSwitch', enabled]);
      if (switchState.failWith) throw switchState.failWith;
      state.enabled = enabled;
      state.journey = enabled ? journey : null;
      return { enabled, stopped: enabled ? [] : [{ id: ID, name: 'One' }], stillRunning: [] };
    },
    setMachine: async (machine) => { calls.push(['setMachine', machine]); return machinePlace; },
  });
  const server = http.createServer(app);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { call, calls, state };
};

const journeyOf = (overrides = {}) => {
  const calls = [];
  const record = (name, value) => async (...args) => { calls.push([name, ...args]); if (value instanceof Error) throw value; return value; };
  return {
    calls,
    listSpaces: record('listSpaces', [{ id: ID, name: 'One', state: 'running' }]),
    createSpace: record('createSpace', { id: ID, state: 'preparing' }),
    startSpace: record('startSpace', { id: ID, state: 'running' }),
    stopSpace: record('stopSpace', { id: ID, state: 'exited' }),
    restartSpace: record('restartSpace', { id: ID, state: 'running', networkRestored: true }),
    restartOpenCode: record('restartOpenCode', { id: ID, state: 'running' }),
    removeSpace: record('removeSpace', { id: ID, removed: true }),
    grantAccess: record('grantAccess', { grant: { id: 'open-1' } }),
    openDomain: record('openDomain', { network: { mode: 'allowlist', domains: ['registry.npmjs.org'] } }),
    readJournal: record('readJournal', { records: [], dropped: 0, since: 'now' }),
    previewApply: record('previewApply', { changedPaths: 2 }),
    applySpace: record('applySpace', { applied: { status: 'applied' } }),
    stopAllSpaces: record('stopAllSpaces', { stopped: [], stillRunning: [] }),
    readIdleStopSetting: record('readIdleStopSetting', { enabled: true, hours: 4 }),
    changeIdleStop: record('changeIdleStop', { enabled: false, hours: 8 }),
    runSetup: record('runSetup', { id: ID, state: 'running', setup: { state: 'running', index: 0, total: 1, command: 'npm ci' } }),
    readSetup: record('readSetup', { setup: null, output: null }),
    readHostLogins: record('readHostLogins', { logins: [{ provider: 'openai', method: 'chatgpt-token-sharing', expires: '2026-09-26T11:00:00.000Z', state: 'usable' }] }),
    readHostCustomProviders: record('readHostCustomProviders', { providers: [{ id: 'ollama-local', name: 'Ollama (local)', hasKey: false }] }),
    readDisk: record('readDisk', { imageBytes: null, toolsBytes: 0, spacesBytes: 0, freeBytes: 0, freesImage: false }),
    cleanUpDisk: record('cleanUpDisk', { freedBytes: 0, kept: [], disk: null }),
    pullImage: record('pullImage', { imageBytes: null, imagePulling: true, imageFailure: null, toolsBytes: 0, spacesBytes: 0, freeBytes: 0, freesImage: false }),
    ...overrides,
  };
};

describe('space routes', () => {
  it('answers every journey route with 404 and isolated_spaces_off while the feature is off, and the switch still works', async () => {
    const { call, calls } = await serve({ journey: null, switchState: { enabled: false } });
    for (const [method, path] of [['GET', ''], ['POST', ''], ['GET', '/places'], ['POST', `/${ID}/start`], ['POST', `/${ID}/stop`], ['POST', `/${ID}/restart`], ['POST', `/${ID}/restart-opencode`], ['POST', `/${ID}/grants`], ['GET', '/logins'], ['GET', '/custom-providers'], ['DELETE', `/${ID}`], ['GET', `/${ID}/journal`], ['GET', `/${ID}/apply`], ['POST', `/${ID}/apply`], ['GET', '/idle-stop'], ['PUT', '/idle-stop'], ['POST', `/${ID}/setup`], ['GET', `/${ID}/setup`], ['GET', '/places/docker/disk'], ['POST', '/places/docker/clean-up'], ['POST', '/places/docker/image'], ['GET', '/places/local/setup'], ['POST', '/places/local/setup']]) {
      expect(await call(method, `${SPACES_ROUTE}${path}`, method === 'GET' || method === 'DELETE' ? undefined : {}), `${method} ${path}`).toEqual({ status: 404, body: { code: 'isolated_spaces_off', message: 'Isolated spaces are turned off.', details: null } });
    }
    expect(await call('GET', `${SPACES_ROUTE}/switch`)).toEqual({ status: 200, body: { enabled: false, spaces: [] } });
    expect(await call('PUT', `${SPACES_ROUTE}/switch`, { enabled: true })).toEqual({ status: 200, body: { enabled: true, stopped: [], stillRunning: [] } });
    expect(calls).toEqual([['setSwitch', true]]);
    expect(await call('PUT', `${SPACES_ROUTE}/switch`, { enabled: 'yes' })).toMatchObject({ status: 400, body: { code: 'invalid_request_body' } });
    expect(await call('PUT', `${SPACES_ROUTE}/switch`, [])).toMatchObject({ status: 400, body: { code: 'invalid_request_body' } });
  });

  it('reports what turning the switch off would stop, and what it stopped', async () => {
    const journey = journeyOf();
    const { call, state } = await serve({ journey });
    expect(await call('GET', `${SPACES_ROUTE}/switch`)).toEqual({ status: 200, body: { enabled: true, spaces: [{ id: ID, name: 'One', state: 'running' }] } });
    expect(await call('PUT', `${SPACES_ROUTE}/switch`, { enabled: false })).toEqual({ status: 200, body: { enabled: false, stopped: [{ id: ID, name: 'One' }], stillRunning: [] } });
    expect(state.journey).toBeNull();
    expect(await call('GET', SPACES_ROUTE)).toMatchObject({ status: 404, body: { code: 'isolated_spaces_off' } });
  });

  it('says what gets Docker going on this computer, and starts only a known action', async () => {
    const started = [];
    const dockerSetup = {
      describe: async (checked) => ({ remedy: checked.available ? null : 'start_colima', job: null, memory: null }),
      readJob: () => ({ action: 'start_colima', running: true, failure: null }),
      start: async (action) => {
        started.push(action);
        if (action === 'install_all') throw new SpaceError('docker_setup_not_offered', 'Docker is in another state now. Check again.');
        return { action, running: true, failure: null };
      },
    };
    const places = [
      { id: 'docker', machine: null, check: async () => ({ available: false, code: 'docker_daemon_unreachable', message: 'down' }) },
      { id: 'docker-ssh', machine: 'box', check: async () => ({ available: false, code: 'docker_daemon_unreachable', message: 'down there' }) },
    ];
    const { call } = await serve({ journey: journeyOf(), places, dockerSetup });
    expect(await call('GET', `${SPACES_ROUTE}/places`)).toEqual({ status: 200, body: { places: [
      { id: 'docker', machine: null, available: false, code: 'docker_daemon_unreachable', message: 'down', setup: { remedy: 'start_colima', job: null, memory: null } },
      // The other machine is the user's to set up.
      { id: 'docker-ssh', machine: 'box', available: false, code: 'docker_daemon_unreachable', message: 'down there', setup: null },
    ] } });
    expect(await call('GET', `${SPACES_ROUTE}/places/local/setup`)).toEqual({ status: 200, body: { job: { action: 'start_colima', running: true, failure: null } } });
    expect(await call('POST', `${SPACES_ROUTE}/places/local/setup`, { action: 'start_colima' })).toEqual({ status: 202, body: { job: { action: 'start_colima', running: true, failure: null } } });
    expect(await call('POST', `${SPACES_ROUTE}/places/local/setup`, { action: 'install_all' })).toMatchObject({ status: 409, body: { code: 'docker_setup_not_offered' } });
    expect(await call('POST', `${SPACES_ROUTE}/places/local/setup`, { action: 'sudo rm' })).toMatchObject({ status: 400, body: { code: 'invalid_request_body' } });
    expect(started).toEqual(['start_colima', 'install_all']);
  });

  it('passes a refusal of the switch on with its status', async () => {
    const { call } = await serve({ journey: journeyOf(), switchState: { enabled: true, failWith: new SpaceError('space_preparing', 'A space is still being made.', { spaces: [ID] }) } });
    expect(await call('PUT', `${SPACES_ROUTE}/switch`, { enabled: false })).toEqual({ status: 409, body: { code: 'space_preparing', message: 'A space is still being made.', details: { spaces: [ID] } } });
  });

  it('translates each route into the journey call it stands for', async () => {
    const journey = journeyOf();
    const places = [
      { id: 'docker', machine: null, check: async () => ({ available: true, version: '29.2.1', hostIsolation: true }) },
      { id: 'docker-ssh', machine: 'box', check: async () => ({ available: false, code: 'place_unreachable', message: 'box did not answer' }) },
    ];
    const machinePlace = { id: 'docker-ssh', machine: 'other', available: true, version: '29.2.1', hostIsolation: true };
    const { call, calls } = await serve({ journey, places, machinePlace });
    expect(await call('GET', `${SPACES_ROUTE}/places`)).toEqual({ status: 200, body: { places: [
      { id: 'docker', machine: null, available: true, version: '29.2.1', hostIsolation: true, setup: null },
      { id: 'docker-ssh', machine: 'box', available: false, code: 'place_unreachable', message: 'box did not answer', setup: null },
    ] } });
    expect(await call('PUT', `${SPACES_ROUTE}/machine`, { machine: 'other' })).toEqual({ status: 200, body: { place: machinePlace } });
    expect(await call('PUT', `${SPACES_ROUTE}/machine`, { machine: 7 })).toMatchObject({ status: 400, body: { code: 'invalid_request_body' } });
    expect(calls).toEqual([['setMachine', 'other']]);
    expect(await call('GET', SPACES_ROUTE)).toEqual({ status: 200, body: { spaces: [{ id: ID, name: 'One', state: 'running' }] } });
    expect(await call('GET', `${SPACES_ROUTE}/places/docker/disk`)).toEqual({ status: 200, body: { imageBytes: null, toolsBytes: 0, spacesBytes: 0, freeBytes: 0, freesImage: false } });
    expect(await call('POST', `${SPACES_ROUTE}/places/docker/clean-up`)).toEqual({ status: 200, body: { freedBytes: 0, kept: [], disk: null } });
    expect(await call('POST', `${SPACES_ROUTE}/places/docker/image`)).toEqual({ status: 202, body: { imageBytes: null, imagePulling: true, imageFailure: null, toolsBytes: 0, spacesBytes: 0, freeBytes: 0, freesImage: false } });
    const request = { projectDirectory: '/home/me/project', name: 'One', start: 'clean', network: { mode: 'open' } };
    expect(await call('POST', SPACES_ROUTE, request)).toEqual({ status: 202, body: { id: ID, state: 'preparing' } });
    expect(await call('POST', `${SPACES_ROUTE}/${ID}/start`)).toEqual({ status: 200, body: { id: ID, state: 'running' } });
    expect(await call('POST', `${SPACES_ROUTE}/${ID}/stop`)).toEqual({ status: 200, body: { id: ID, state: 'exited' } });
    expect(await call('POST', `${SPACES_ROUTE}/${ID}/restart`)).toEqual({ status: 200, body: { id: ID, state: 'running', networkRestored: true } });
    expect(await call('POST', `${SPACES_ROUTE}/${ID}/restart-opencode`)).toEqual({ status: 200, body: { id: ID, state: 'running' } });
    expect(await call('POST', `${SPACES_ROUTE}/${ID}/grants`, { kind: 'domain', upstream: 'https://registry.example.com/' })).toEqual({ status: 200, body: { grant: { id: 'open-1' } } });
    expect(await call('POST', `${SPACES_ROUTE}/${ID}/network/domains`, { domain: 'registry.npmjs.org' })).toEqual({ status: 200, body: { network: { mode: 'allowlist', domains: ['registry.npmjs.org'] } } });
    expect(await call('GET', `${SPACES_ROUTE}/logins`)).toEqual({ status: 200, body: { logins: [{ provider: 'openai', method: 'chatgpt-token-sharing', expires: '2026-09-26T11:00:00.000Z', state: 'usable' }] } });
    expect(await call('GET', `${SPACES_ROUTE}/custom-providers?directory=%2Fhome%2Fme%2Fproject`)).toEqual({ status: 200, body: { providers: [{ id: 'ollama-local', name: 'Ollama (local)', hasKey: false }] } });
    expect(await call('GET', `${SPACES_ROUTE}/${ID}/journal`)).toEqual({ status: 200, body: { records: [], dropped: 0, since: 'now' } });
    expect(await call('GET', `${SPACES_ROUTE}/${ID}/apply`)).toEqual({ status: 200, body: { changedPaths: 2 } });
    expect(await call('POST', `${SPACES_ROUTE}/${ID}/apply`, { as: 'branch', branch: 'b' })).toEqual({ status: 200, body: { applied: { status: 'applied' } } });
    expect(await call('POST', `${SPACES_ROUTE}/${ID}/setup`, { commands: ['npm ci'] })).toEqual({ status: 200, body: { id: ID, state: 'running', setup: { state: 'running', index: 0, total: 1, command: 'npm ci' } } });
    expect(await call('GET', `${SPACES_ROUTE}/${ID}/setup`)).toEqual({ status: 200, body: { setup: null, output: null } });
    expect(await call('DELETE', `${SPACES_ROUTE}/${ID}`)).toEqual({ status: 200, body: { id: ID, removed: true } });
    expect(journey.calls).toEqual([
      ['listSpaces', { access: true }], ['readDisk', 'docker'], ['cleanUpDisk', 'docker'], ['pullImage', 'docker'], ['createSpace', request], ['startSpace', ID], ['stopSpace', ID], ['restartSpace', ID], ['restartOpenCode', ID], ['grantAccess', ID, { kind: 'domain', upstream: 'https://registry.example.com/' }], ['openDomain', ID, { domain: 'registry.npmjs.org' }], ['readHostLogins'], ['readHostCustomProviders', '/home/me/project'], ['readJournal', ID], ['previewApply', ID], ['applySpace', ID, { as: 'branch', branch: 'b' }], ['runSetup', ID, { commands: ['npm ci'] }], ['readSetup', ID], ['removeSpace', ID, { allowUnsaved: false }],
    ]);
  });

  it('reads and changes the idle stop setting through the journey, and refuses a body that is not an object', async () => {
    const journey = journeyOf();
    const { call } = await serve({ journey });
    expect(await call('GET', `${SPACES_ROUTE}/idle-stop`)).toEqual({ status: 200, body: { enabled: true, hours: 4 } });
    expect(await call('PUT', `${SPACES_ROUTE}/idle-stop`, { enabled: false, hours: 8 })).toEqual({ status: 200, body: { enabled: false, hours: 8 } });
    expect(await call('PUT', `${SPACES_ROUTE}/idle-stop`, [8])).toMatchObject({ status: 400, body: { code: 'invalid_request_body' } });
    expect(journey.calls).toEqual([['readIdleStopSetting'], ['changeIdleStop', { enabled: false, hours: 8 }]]);

    const refusing = journeyOf({ changeIdleStop: async () => { throw new SpaceError('invalid_idle_stop', 'whole hours from 1 to 168'); } });
    const second = await serve({ journey: refusing });
    expect(await second.call('PUT', `${SPACES_ROUTE}/idle-stop`, { enabled: true, hours: 0 })).toMatchObject({ status: 400, body: { code: 'invalid_idle_stop' } });
  });

  it('refuses an id that is not a space id before the journey is asked, and a body that is not an object', async () => {
    const journey = journeyOf();
    const { call } = await serve({ journey });
    for (const bad of ['ABCDEF012345', '0f0f0f0f0f0', 'a1b2c3d4e5f6x']) {
      expect(await call('POST', `${SPACES_ROUTE}/${encodeURIComponent(bad)}/start`)).toMatchObject({ status: 404, body: { code: 'space_not_found' } });
    }
    expect(await call('POST', SPACES_ROUTE, [1])).toMatchObject({ status: 400, body: { code: 'invalid_request_body' } });
    expect(journey.calls).toEqual([]);
  });

  it('gives each refusal of the journey the status of its code, and never a stack', async () => {
    const answers = [];
    const res = { status(code) { this.code = code; return this; }, json(body) { answers.push({ status: this.code, body }); } };
    const cases = [
      ['space_not_found', 404], ['isolated_spaces_off', 404], ['project_not_registered', 400], ['invalid_network', 400], ['space_preparing', 409], ['space_not_running', 409],
      ['space_busy', 409], ['space_creation_failed', 409], ['invalid_grant_request', 400], ['secret_source_missing', 409], ['login_not_found', 409], ['login_not_supported', 409], ['login_expired', 409], ['space_record_unreadable', 409], ['invalid_domain', 400], ['network_is_open', 409], ['too_many_domains', 409],
      ['branch_exists', 409], ['changes_do_not_apply', 409], ['changes_route_closed', 409], ['nothing_to_apply', 409], ['place_cannot_restrict_network', 409],
      ['invalid_setup_commands', 400], ['space_setup_running', 409],
      ['space_remove_incomplete', 502], ['docker_command_failed', 502], ['code_out_failed', 502],
    ];
    for (const [code, status] of cases) {
      answerFailure(res, new SpaceError(code, `about ${code}`, { step: 'x' }));
      expect(answers.at(-1), code).toEqual({ status, body: { code, message: `about ${code}`, details: { step: 'x' } } });
    }
    answerFailure(res, new TypeError('boom'));
    expect(answers.at(-1)).toEqual({ status: 500, body: { code: 'space_journey_failed', message: 'boom', details: null } });
    expect(JSON.stringify(answers)).not.toContain('at ');
  });
});

describe('the switch controller', () => {
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const hostOf = (name, { spaces = [], listFails = false, machine = null, idle = true } = {}) => {
    const host = {
      name,
      closed: 0,
      reopened: 0,
      journey: {
        listSpaces: async () => { if (listFails) throw new SpaceError('docker_command_failed', 'docker ps exited 1'); return spaces; },
        stopAllSpaces: async () => { await sleep(30); return { stopped: spaces.map(({ id, name: spaceName }) => ({ id, name: spaceName })), stillRunning: [] }; },
        reopen: () => { host.reopened += 1; },
        isIdle: () => idle,
      },
      places: () => [
        { id: 'docker', machine: null, check: async () => ({ available: true }) },
        ...(machine === null ? [] : [{ id: 'docker-ssh', machine, check: async () => ({ available: true, version: '29.2.1', hostIsolation: true }) }]),
      ],
      close: () => { host.closed += 1; },
    };
    return host;
  };
  const controllerWith = ({ host = null, persistFails = false } = {}) => {
    const state = { host, built: 0, started: [], persisted: [], machines: [] };
    const controller = createSwitchController({
      getHost: () => state.host,
      setHost: (next) => { state.host = next; },
      buildHost: () => { state.built += 1; return hostOf(`built-${state.built}`, { machine: state.machines.at(-1) || null }); },
      startHost: (made) => { state.started.push(made.name); },
      persist: async (enabled) => { await sleep(10); if (persistFails) throw new Error('disk full'); state.persisted.push(enabled); },
      persistMachine: async (machine) => { state.machines.push(machine); },
    });
    return { controller, state };
  };

  it('reads the switch, and says the list is unknown rather than failing when the place cannot be asked', async () => {
    expect(await controllerWith().controller.readSwitch()).toEqual({ enabled: false, spaces: [] });
    const on = controllerWith({ host: hostOf('on', { spaces: [{ id: ID, name: 'One', state: 'running', extra: 1 }] }) });
    expect(await on.controller.readSwitch()).toEqual({ enabled: true, spaces: [{ id: ID, name: 'One', state: 'running' }] });
    const down = controllerWith({ host: hostOf('down', { listFails: true }) });
    expect(await down.controller.readSwitch()).toEqual({ enabled: true, spaces: null, failure: { code: 'docker_command_failed', message: 'docker ps exited 1' } });
  });

  it('builds one host for two turn-ons at once, and closes the one host once for two turn-offs', async () => {
    const { controller, state } = controllerWith();
    const [first, second] = await Promise.all([controller.setSwitch(true), controller.setSwitch(true)]);
    expect(first).toEqual({ enabled: true, stopped: [], stillRunning: [] });
    expect(second).toEqual(first);
    expect(state.built).toBe(1);
    expect(state.started).toEqual(['built-1']);
    expect(state.persisted).toEqual([true]);
    const on = state.host;
    const [offFirst, offSecond] = await Promise.all([controller.setSwitch(false), controller.setSwitch(false)]);
    expect(offFirst).toEqual({ enabled: false, stopped: [], stillRunning: [] });
    expect(offSecond).toEqual(offFirst);
    expect(on.closed).toBe(1);
    expect(state.host).toBeNull();
    expect(state.persisted).toEqual([true, false]);
  });

  it('stops the spaces, writes the setting and only then closes the host; a setting that cannot be written leaves the feature on and open again', async () => {
    const host = hostOf('on', { spaces: [{ id: ID, name: 'One', state: 'running' }] });
    const failing = controllerWith({ host, persistFails: true });
    await expect(failing.controller.setSwitch(false)).rejects.toThrow('disk full');
    expect(host.closed).toBe(0);
    expect(host.reopened).toBe(1);
    expect(failing.state.host).toBe(host);

    const { controller, state } = controllerWith({ host });
    expect(await controller.setSwitch(false)).toEqual({ enabled: false, stopped: [{ id: ID, name: 'One' }], stillRunning: [] });
    expect(host.closed).toBe(1);
    expect(state.host).toBeNull();
    // A turn-on that arrived while the turn-off was running builds the host after it, once.
    const [off, on] = await Promise.all([controller.setSwitch(false), controller.setSwitch(true)]);
    expect(off.enabled).toBe(false);
    expect(on.enabled).toBe(true);
    expect(state.built).toBe(1);
  });

  it('changes the machine by replacing the host without a stop, and refuses an invalid one, one with spaces on it, and one while the host is busy', async () => {
    const host = hostOf('on', { spaces: [{ id: ID, name: 'One', state: 'running', placeId: 'docker' }], machine: 'box' });
    const { controller, state } = controllerWith({ host });
    // The same machine again: nothing is written or rebuilt, the place is answered checked.
    expect(await controller.setMachine('box')).toEqual({ id: 'docker-ssh', machine: 'box', available: true, version: '29.2.1', hostIsolation: true });
    expect(state.built).toBe(0);
    await expect(controller.setMachine('-Jbox')).rejects.toMatchObject({ code: 'invalid_machine' });
    await expect(controller.setMachine('a b')).rejects.toMatchObject({ code: 'invalid_machine' });
    expect(await controller.setMachine('other')).toEqual({ id: 'docker-ssh', machine: 'other', available: true, version: '29.2.1', hostIsolation: true });
    expect(state.machines).toEqual(['other']);
    expect(state.built).toBe(1);
    expect(state.started).toEqual(['built-1']);
    expect(host.closed).toBe(1);
    expect(host.reopened).toBe(0);
    expect(state.host.name).toBe('built-1');
    // Nothing was stopped: the old host's spaces stay as they are.
    expect(state.persisted).toEqual([]);
    // Cleared: the place goes.
    expect(await controller.setMachine('')).toBeNull();
    expect(state.machines).toEqual(['other', '']);
    expect(state.host.places().map((place) => place.id)).toEqual(['docker']);

    const occupied = controllerWith({ host: hostOf('on', { spaces: [{ id: ID, name: 'One', state: 'unreachable', placeId: 'docker-ssh' }], machine: 'box' }) });
    await expect(occupied.controller.setMachine('')).rejects.toMatchObject({ code: 'place_has_spaces', details: { count: 1 } });
    expect(occupied.state.built).toBe(0);
    expect(occupied.state.machines).toEqual([]);
    const busy = controllerWith({ host: hostOf('on', { machine: 'box', idle: false }) });
    await expect(busy.controller.setMachine('other')).rejects.toMatchObject({ code: 'space_busy' });
    expect(busy.state.machines).toEqual([]);
    // A creation that began while the new host was built: the new host is closed, the setting goes back, the old host stays.
    const late = hostOf('on', { machine: 'box' });
    let idle = true;
    late.journey.isIdle = () => idle;
    const lateState = { host: late, machines: [], started: [] };
    const buildThenBusy = createSwitchController({
      getHost: () => lateState.host,
      setHost: (next) => { lateState.host = next; },
      buildHost: () => { idle = false; return hostOf('built-late', { machine: 'other' }); },
      startHost: (made) => { lateState.started.push(made.name); },
      persist: async () => {},
      persistMachine: async (machine) => { lateState.machines.push(machine); },
    });
    await expect(buildThenBusy.setMachine('other')).rejects.toMatchObject({ code: 'space_busy' });
    expect(lateState.machines).toEqual(['other', 'box']);
    expect(lateState.started).toEqual([]);
    expect(lateState.host).toBe(late);
    expect(late.closed).toBe(0);
    // A build that fails leaves the file naming the machine the running host has.
    const brokenState = { host: hostOf('on', { machine: 'box' }), machines: [] };
    const broken = createSwitchController({
      getHost: () => brokenState.host,
      setHost: (next) => { brokenState.host = next; },
      buildHost: async () => { throw new Error('docker gone'); },
      startHost: () => {},
      persist: async () => {},
      persistMachine: async (machine) => { brokenState.machines.push(machine); },
    });
    await expect(broken.setMachine('other')).rejects.toThrow('docker gone');
    expect(brokenState.machines).toEqual(['other', 'box']);
    const unlisted = controllerWith({ host: hostOf('on', { machine: 'box', listFails: true }) });
    await expect(unlisted.controller.setMachine('other')).rejects.toMatchObject({ code: 'docker_command_failed' });
    await expect(controllerWith().controller.setMachine('box')).rejects.toMatchObject({ code: 'isolated_spaces_off' });
  });
});
