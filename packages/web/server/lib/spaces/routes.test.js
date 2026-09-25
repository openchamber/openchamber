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
const serve = async ({ journey, places = [], switchState = { enabled: true } } = {}) => {
  const app = express();
  app.use(express.json());
  const calls = [];
  const state = { journey, enabled: switchState.enabled };
  registerSpaceRoutes(app, {
    getJourney: () => state.journey,
    getPlaces: () => places,
    readSwitch: async () => ({ enabled: state.enabled, spaces: state.enabled ? [{ id: ID, name: 'One', state: 'running' }] : [] }),
    setSwitch: async (enabled) => {
      calls.push(['setSwitch', enabled]);
      if (switchState.failWith) throw switchState.failWith;
      state.enabled = enabled;
      state.journey = enabled ? journey : null;
      return { enabled, stopped: enabled ? [] : [{ id: ID, name: 'One' }], stillRunning: [] };
    },
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
    removeSpace: record('removeSpace', { id: ID, removed: true }),
    readJournal: record('readJournal', { records: [], dropped: 0, since: 'now' }),
    previewApply: record('previewApply', { changedPaths: 2 }),
    applySpace: record('applySpace', { applied: { status: 'applied' } }),
    stopAllSpaces: record('stopAllSpaces', { stopped: [], stillRunning: [] }),
    ...overrides,
  };
};

describe('space routes', () => {
  it('answers every journey route with 404 and isolated_spaces_off while the feature is off, and the switch still works', async () => {
    const { call, calls } = await serve({ journey: null, switchState: { enabled: false } });
    for (const [method, path] of [['GET', ''], ['POST', ''], ['GET', '/places'], ['POST', `/${ID}/start`], ['POST', `/${ID}/stop`], ['DELETE', `/${ID}`], ['GET', `/${ID}/journal`], ['GET', `/${ID}/apply`], ['POST', `/${ID}/apply`]]) {
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

  it('passes a refusal of the switch on with its status', async () => {
    const { call } = await serve({ journey: journeyOf(), switchState: { enabled: true, failWith: new SpaceError('space_preparing', 'A space is still being made.', { spaces: [ID] }) } });
    expect(await call('PUT', `${SPACES_ROUTE}/switch`, { enabled: false })).toEqual({ status: 409, body: { code: 'space_preparing', message: 'A space is still being made.', details: { spaces: [ID] } } });
  });

  it('translates each route into the journey call it stands for', async () => {
    const journey = journeyOf();
    const places = [{ id: 'docker', check: async () => ({ available: true, version: '29.2.1', hostIsolation: true }) }];
    const { call } = await serve({ journey, places });
    expect(await call('GET', `${SPACES_ROUTE}/places`)).toEqual({ status: 200, body: { places: [{ id: 'docker', available: true, version: '29.2.1', hostIsolation: true }] } });
    expect(await call('GET', SPACES_ROUTE)).toEqual({ status: 200, body: { spaces: [{ id: ID, name: 'One', state: 'running' }] } });
    const request = { projectDirectory: '/home/me/project', name: 'One', start: 'clean', network: { mode: 'open' } };
    expect(await call('POST', SPACES_ROUTE, request)).toEqual({ status: 202, body: { id: ID, state: 'preparing' } });
    expect(await call('POST', `${SPACES_ROUTE}/${ID}/start`)).toEqual({ status: 200, body: { id: ID, state: 'running' } });
    expect(await call('POST', `${SPACES_ROUTE}/${ID}/stop`)).toEqual({ status: 200, body: { id: ID, state: 'exited' } });
    expect(await call('GET', `${SPACES_ROUTE}/${ID}/journal`)).toEqual({ status: 200, body: { records: [], dropped: 0, since: 'now' } });
    expect(await call('GET', `${SPACES_ROUTE}/${ID}/apply`)).toEqual({ status: 200, body: { changedPaths: 2 } });
    expect(await call('POST', `${SPACES_ROUTE}/${ID}/apply`, { as: 'branch', branch: 'b' })).toEqual({ status: 200, body: { applied: { status: 'applied' } } });
    expect(await call('DELETE', `${SPACES_ROUTE}/${ID}`)).toEqual({ status: 200, body: { id: ID, removed: true } });
    expect(journey.calls).toEqual([
      ['listSpaces'], ['createSpace', request], ['startSpace', ID], ['stopSpace', ID], ['readJournal', ID], ['previewApply', ID], ['applySpace', ID, { as: 'branch', branch: 'b' }], ['removeSpace', ID],
    ]);
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
      ['space_busy', 409], ['space_creation_failed', 409],
      ['branch_exists', 409], ['changes_do_not_apply', 409], ['changes_route_closed', 409], ['nothing_to_apply', 409], ['place_cannot_restrict_network', 409],
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
  const hostOf = (name, { spaces = [], listFails = false } = {}) => {
    const host = {
      name,
      closed: 0,
      reopened: 0,
      journey: {
        listSpaces: async () => { if (listFails) throw new SpaceError('docker_command_failed', 'docker ps exited 1'); return spaces; },
        stopAllSpaces: async () => { await sleep(30); return { stopped: spaces.map(({ id, name: spaceName }) => ({ id, name: spaceName })), stillRunning: [] }; },
        reopen: () => { host.reopened += 1; },
      },
      close: () => { host.closed += 1; },
    };
    return host;
  };
  const controllerWith = ({ host = null, persistFails = false } = {}) => {
    const state = { host, built: 0, started: [], persisted: [] };
    const controller = createSwitchController({
      getHost: () => state.host,
      setHost: (next) => { state.host = next; },
      buildHost: () => { state.built += 1; return hostOf(`built-${state.built}`); },
      startHost: (made) => { state.started.push(made.name); },
      persist: async (enabled) => { await sleep(10); if (persistFails) throw new Error('disk full'); state.persisted.push(enabled); },
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
});
