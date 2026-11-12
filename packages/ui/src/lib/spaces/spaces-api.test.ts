import { afterEach, describe, expect, test } from 'bun:test';

import { applySpaceWork, cleanUpSpaceDisk, createSpace, listSpacePlaces, listSpaces, previewSpaceApply, openSpaceDomain, pullSpaceImage, readDockerSetupJob, readSpaceDisk, readSpaceIdleStop, readSpaceJournal, readSpaceSetup, readSpacesSwitch, runSpaceSetup, setSpaceIdleStop, setSpaceMachine, SpacesRequestError, startDockerSetup } from './spaces-api';

const ID = 'a1b2c3d4e5f6';
const originalFetch = globalThis.fetch;

const answer = (status: number, body: string) => {
  const seen: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push(new Request(input instanceof Request ? input : new URL(String(input), 'http://127.0.0.1'), init));
      return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
    },
    originalFetch,
  );
  return seen;
};

const entry = {
  id: ID,
  name: 'Fix login',
  placeId: 'local-docker', machine: null,
  projectDirectory: '/home/me/app',
  directory: `/spaces/${ID}/app`,
  created: '2026-09-26T10:00:00.000Z',
  state: 'preparing',
  step: 'checking_place',
  failure: null,
  network: { mode: 'allowlist', domains: [] },
  history: 'pending',
  grants: [],
  access: null,
  needsAccess: [],
  accessFailures: [],
  damaged: false,
  missing: [],
  orphans: [],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('spaces-api', () => {
  test('parses the list the journey route answers', async () => {
    answer(200, JSON.stringify({ spaces: [entry] }));
    const [space] = await listSpaces();
    expect(space).toMatchObject({ id: ID, state: 'preparing', step: 'checking_place', network: { mode: 'allowlist' } });
  });

  test('parses a failed creation in the list, whose step is "failed", with the rest of the list', async () => {
    // The host lists a creation that failed, here or in a host that quit before the code arrived,
    // with `step: 'failed'`. A list this version could not read would freeze every group's status.
    const failed = { ...entry, id: 'b2c3d4e5f6a7', state: 'failed', step: 'failed', failure: { code: 'space_code_never_arrived', message: 'OpenChamber closed before the code arrived.' } };
    answer(200, JSON.stringify({ spaces: [entry, failed] }));
    expect((await listSpaces()).map((space) => [space.id, space.state, space.step, space.failure?.code ?? null])).toEqual([[ID, 'preparing', 'checking_place', null], ['b2c3d4e5f6a7', 'failed', 'failed', 'space_code_never_arrived']]);
  });

  test('parses a space given the host\'s login (7a) with the rest of the list', async () => {
    // One space with a login grant used to fail the whole list as malformed, and the sidebar then
    // showed no spaces at all.
    const login = { kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing', url: 'http://gatekeeper:8080/model/openai' };
    answer(200, JSON.stringify({ spaces: [entry, { ...entry, id: 'b2c3d4e5f6a7', state: 'running', step: null, grants: [login], access: 'granted' }] }));
    const spaces = await listSpaces();
    expect(spaces.map((space) => space.id)).toEqual([ID, 'b2c3d4e5f6a7']);
    expect(spaces[1]?.grants).toEqual([login]);
  });

  test('reads the folder a space was made for, and names none for a host before 5e-3', async () => {
    const orphan = { ...entry, projectDirectory: null, directory: null, projectFolder: { path: '/home/me/app', found: false } };
    answer(200, JSON.stringify({ spaces: [entry, orphan] }));
    expect((await listSpaces()).map((space) => space.projectFolder)).toEqual([{ path: null, found: null }, { path: '/home/me/app', found: false }]);
  });

  test('reads a space as not stopped for the idle stop unless the host says so', async () => {
    answer(200, JSON.stringify({ spaces: [entry, { ...entry, state: 'exited', stoppedIdle: true }] }));
    expect((await listSpaces()).map((space) => space.stoppedIdle)).toEqual([false, true]);
  });

  test('reads and changes the idle stop setting, and refuses one out of range as malformed', async () => {
    answer(200, JSON.stringify({ enabled: true, hours: 4 }));
    expect(await readSpaceIdleStop()).toEqual({ enabled: true, hours: 4 });
    const seen = answer(200, JSON.stringify({ enabled: false, hours: 12 }));
    expect(await setSpaceIdleStop({ enabled: false, hours: 12 })).toEqual({ enabled: false, hours: 12 });
    expect(seen[0].method).toBe('PUT');
    expect(new URL(seen[0].url).pathname).toBe('/api/openchamber/spaces/idle-stop');
    expect(await seen[0].json()).toEqual({ enabled: false, hours: 12 });
    answer(200, JSON.stringify({ enabled: true, hours: 500 }));
    expect(await readSpaceIdleStop().catch((error: Error) => error)).toMatchObject({ code: 'space_answer_malformed' });
  });

  test('a refusal is thrown with the server\'s code, never answered as an empty list', async () => {
    answer(404, JSON.stringify({ code: 'isolated_spaces_off', message: 'Isolated spaces are turned off.', details: null }));
    const failure = await listSpaces().catch((error: Error) => error);
    expect(failure).toBeInstanceOf(SpacesRequestError);
    expect(failure).toMatchObject({ code: 'isolated_spaces_off', status: 404 });
  });

  test('an answer in an unknown shape is a failure, not data', async () => {
    answer(200, JSON.stringify({ spaces: [{ ...entry, state: 'dancing' }] }));
    expect(await listSpaces().catch((error: Error) => error)).toMatchObject({ code: 'space_answer_malformed' });
  });

  test('the switch keeps "the list could not be read" apart from "nothing to stop"', async () => {
    answer(200, JSON.stringify({ enabled: true, spaces: null, failure: { code: 'docker_unavailable', message: 'Docker is not running.' } }));
    expect(await readSpacesSwitch()).toEqual({ enabled: true, spaces: null, failure: { code: 'docker_unavailable', message: 'Docker is not running.' } });
    answer(200, JSON.stringify({ enabled: true, spaces: [] }));
    expect(await readSpacesSwitch()).toEqual({ enabled: true, spaces: [] });
    answer(200, JSON.stringify({ enabled: false, spaces: [] }));
    expect(await readSpacesSwitch()).toEqual({ enabled: false });
  });

  test('a creation posts the four choices as JSON', async () => {
    const seen = answer(202, JSON.stringify(entry));
    await createSpace({ projectDirectory: '/home/me/app', placeId: 'docker', name: 'Fix login', start: 'clean', network: { mode: 'open', domains: [] }, setupCommands: ['npm ci'], grants: [] });
    expect(seen[0]?.method).toBe('POST');
    expect(new URL(seen[0]?.url ?? '').pathname).toBe('/api/openchamber/spaces');
    expect(await seen[0]?.json()).toEqual({ projectDirectory: '/home/me/app', placeId: 'docker', name: 'Fix login', start: 'clean', network: { mode: 'open', domains: [] }, setupCommands: ['npm ci'], grants: [] });
  });
});

describe('the places', () => {
  test('reads each place with its machine, none from a host before the second place, and an unreachable space with its machine and failure', async () => {
    answer(200, JSON.stringify({ places: [
      { id: 'docker', available: true, hostIsolation: true, version: '29.2.1' },
      { id: 'docker-ssh', machine: 'me@box', available: false, code: 'place_unreachable', message: 'me@box did not answer' },
    ] }));
    expect(await listSpacePlaces()).toEqual([
      { id: 'docker', machine: null, available: true, hostIsolation: true, version: '29.2.1', setup: null },
      { id: 'docker-ssh', machine: 'me@box', available: false, code: 'place_unreachable', message: 'me@box did not answer', setup: null },
    ]);
    answer(200, JSON.stringify({ spaces: [entry, { ...entry, id: 'b2c3d4e5f6a7', placeId: 'docker-ssh', machine: 'me@box', state: 'unreachable', step: null, failure: { code: 'place_unreachable', message: 'me@box did not answer' } }] }));
    const [local, away] = await listSpaces();
    expect(local?.machine).toBeNull();
    expect(away).toMatchObject({ placeId: 'docker-ssh', machine: 'me@box', state: 'unreachable', failure: { code: 'place_unreachable' } });
  });

  test('reads what gets Docker going on this computer, and a remedy from a later host as none', async () => {
    const job = { action: 'start_colima', running: false, failure: { code: 'docker_setup_failed', message: 'colima start exited with code 1', output: 'vz: no memory' } };
    answer(200, JSON.stringify({ places: [
      { id: 'docker', available: false, code: 'docker_daemon_unreachable', message: 'down', setup: { remedy: 'start_colima', job, memory: null } },
      { id: 'docker-next', available: false, code: 'docker_daemon_unreachable', message: 'down', setup: { remedy: 'start_podman', job: null, memory: null } },
      { id: 'docker-up', available: true, hostIsolation: true, setup: { remedy: null, job: null, memory: { bytes: 2147483648, engine: 'colima', low: true } } },
    ] }));
    const [down, later, up] = await listSpacePlaces();
    expect(down?.setup).toEqual({ remedy: 'start_colima', job, memory: null });
    expect(later?.setup?.remedy).toBeNull();
    expect(up?.setup?.memory).toEqual({ bytes: 2147483648, engine: 'colima', low: true });
  });

  test('starts a Docker setup action with a POST and reads the job it answers', async () => {
    const posts = answer(202, JSON.stringify({ job: { action: 'install_all', running: true, failure: null } }));
    expect(await startDockerSetup('install_all')).toEqual({ action: 'install_all', running: true, failure: null });
    expect(posts[0].method).toBe('POST');
    expect(new URL(posts[0].url).pathname).toBe('/api/openchamber/spaces/places/local/setup');
    expect(await posts[0].json()).toEqual({ action: 'install_all' });
    answer(200, JSON.stringify({ job: null }));
    expect(await readDockerSetupJob()).toBeNull();
    answer(409, JSON.stringify({ code: 'docker_setup_not_offered', message: 'Docker is in another state now. Check again.', details: null }));
    expect(await startDockerSetup('start_colima').catch((error: Error) => error)).toMatchObject({ code: 'docker_setup_not_offered', status: 409 });
  });

  test('sets the machine with a PUT and reads the place it answers, or none; a refusal keeps its code', async () => {
    const place = { id: 'docker-ssh', machine: 'me@box', available: true, hostIsolation: true, version: '29.2.1' };
    const puts = answer(200, JSON.stringify({ place }));
    expect(await setSpaceMachine('me@box')).toEqual({ ...place, setup: null });
    expect(puts[0].method).toBe('PUT');
    expect(new URL(puts[0].url).pathname).toBe('/api/openchamber/spaces/machine');
    expect(await puts[0].json()).toEqual({ machine: 'me@box' });
    answer(200, JSON.stringify({ place: null }));
    expect(await setSpaceMachine('')).toBeNull();
    answer(409, JSON.stringify({ code: 'place_has_spaces', message: 'Delete the 2 space(s) on the other machine first.', details: { count: 2 } }));
    expect(await setSpaceMachine('').catch((error: Error) => error)).toMatchObject({ code: 'place_has_spaces', status: 409 });
  });
});

describe('the disk of a place', () => {
  const disk = { imageBytes: 1_632_000_000, imagePulling: false, imageFailure: null, toolsBytes: 438_000_000, spacesBytes: 0, bytesBySpace: {}, freeBytes: 1_632_000_000, freesImage: true };

  test('starts the image download with a POST and reads the disk it answers; a host that says nothing of a download is read as none', async () => {
    const pulling = { ...disk, imageBytes: null, freeBytes: 0, freesImage: false, imagePulling: true };
    const posts = answer(202, JSON.stringify(pulling));
    expect(await pullSpaceImage('docker')).toEqual(pulling);
    expect(posts[0].method).toBe('POST');
    expect(new URL(posts[0].url).pathname).toBe('/api/openchamber/spaces/places/docker/image');
    const older = { imageBytes: disk.imageBytes, toolsBytes: disk.toolsBytes, spacesBytes: disk.spacesBytes, freeBytes: disk.freeBytes, freesImage: disk.freesImage };
    answer(200, JSON.stringify(older));
    expect(await readSpaceDisk('docker')).toEqual(disk);
  });

  test('reads the disk of a place, and a clean-up is a POST that answers what was freed and the disk after', async () => {
    const reads = answer(200, JSON.stringify(disk));
    expect(await readSpaceDisk('docker')).toEqual(disk);
    expect(new URL(reads[0].url).pathname).toBe('/api/openchamber/spaces/places/docker/disk');
    const cleaned = { freedBytes: 1_632_000_000, kept: [{ kind: 'tools', reason: 'in_use' }], disk: { ...disk, imageBytes: null, freeBytes: 0, freesImage: false } };
    const posts = answer(200, JSON.stringify(cleaned));
    expect(await cleanUpSpaceDisk('docker')).toEqual(cleaned);
    expect(posts[0].method).toBe('POST');
    expect(new URL(posts[0].url).pathname).toBe('/api/openchamber/spaces/places/docker/clean-up');
  });

  test('a failed read of the disk is thrown with its code, never answered as an empty disk', async () => {
    answer(502, JSON.stringify({ code: 'docker_command_failed', message: 'docker system df failed', details: null }));
    expect(await readSpaceDisk('docker').catch((error: Error) => error)).toMatchObject({ code: 'docker_command_failed', status: 502 });
    answer(200, JSON.stringify({ imageBytes: null }));
    expect(await readSpaceDisk('docker').catch((error: Error) => error)).toMatchObject({ code: 'space_answer_malformed' });
  });
});

describe('the journal and opened domains', () => {
  test('reads the setup commands\' run, none from a host that does not know them, and runs them again with a POST', async () => {
    answer(200, JSON.stringify({ spaces: [entry] }));
    expect((await listSpaces())[0]?.setup).toBeNull();
    const failed = { state: 'failed', index: 1, total: 2, command: 'npm ci', exitCode: 1, timedOut: false, startedAt: '2026-09-28T10:00:00.000Z', finishedAt: '2026-09-28T10:01:00.000Z' };
    answer(200, JSON.stringify({ spaces: [{ ...entry, setup: failed }] }));
    expect((await listSpaces())[0]?.setup).toEqual(failed);
    // A host from before the run's span was kept answers none.
    const older = { state: 'failed', index: 1, total: 2, command: 'npm ci', exitCode: 1, timedOut: false };
    answer(200, JSON.stringify({ spaces: [{ ...entry, setup: older }] }));
    expect((await listSpaces())[0]?.setup).toEqual({ ...older, startedAt: null, finishedAt: null });
    answer(200, JSON.stringify({ spaces: [{ ...entry, setup: { state: 'paused' } }] }));
    expect(await listSpaces().catch((error: Error) => error)).toMatchObject({ code: 'space_answer_malformed' });

    const seen = answer(200, JSON.stringify({ ...entry, state: 'running', setup: { state: 'running', index: 0, total: 1, command: 'npm ci' } }));
    expect((await runSpaceSetup(ID, ['npm ci'])).setup).toEqual({ state: 'running', index: 0, total: 1, command: 'npm ci' });
    expect(seen[0]?.method).toBe('POST');
    expect(new URL(seen[0]?.url ?? '').pathname).toBe(`/api/openchamber/spaces/${ID}/setup`);
    expect(await seen[0]?.json()).toEqual({ commands: ['npm ci'] });

    answer(200, JSON.stringify({ setup: failed, output: 'npm ERR! 403' }));
    expect(await readSpaceSetup(ID)).toEqual({ setup: failed, output: 'npm ERR! 403' });
    answer(409, JSON.stringify({ code: 'space_setup_running', message: 'still running' }));
    expect(await runSpaceSetup(ID, ['npm ci']).catch((error: Error) => error)).toMatchObject({ code: 'space_setup_running', status: 409 });
  });

  test('opens a domain with a POST that names it, and answers the network as it now is', async () => {
    const seen = answer(200, JSON.stringify({ network: { mode: 'allowlist', domains: ['registry.npmjs.org'] } }));
    expect(await openSpaceDomain(ID, 'registry.npmjs.org')).toEqual({ mode: 'allowlist', domains: ['registry.npmjs.org'] });
    expect(seen[0].method).toBe('POST');
    expect(new URL(seen[0].url).pathname).toBe(`/api/openchamber/spaces/${ID}/network/domains`);
    expect(await seen[0].json()).toEqual({ domain: 'registry.npmjs.org' });
  });

  test('reads the journal, and a journal without records is an error, never an empty one', async () => {
    const journal = { records: [{ at: '2026-09-27T10:00:00.000Z', listener: 'corridor', host: 'registry.npmjs.org', port: 443, decision: 'deny:not-on-allowlist' }], dropped: 0, since: '2026-09-27T09:00:00.000Z' };
    answer(200, JSON.stringify(journal));
    expect(await readSpaceJournal(ID)).toEqual(journal);
    answer(200, JSON.stringify({ dropped: 0, since: 'x' }));
    expect(await readSpaceJournal(ID).catch((error: Error) => error)).toMatchObject({ code: 'space_answer_malformed' });
    answer(409, JSON.stringify({ code: 'space_not_running', message: 'stopped' }));
    expect(await readSpaceJournal(ID).catch((error: Error) => error)).toBeInstanceOf(SpacesRequestError);
  });
  test('parses what an apply would do, and keeps the file a refusal names', async () => {
    const paths = { count: 0, paths: [] };
    answer(200, JSON.stringify({ result: 'c'.repeat(40), changedPaths: 3, changedBytes: 2048, nestedRepositories: paths, unmerged: { count: 101, paths: ['a.txt'] }, changesRoute: 'open', lastApplied: null, newPaths: 3, newPathsOverLimit: false, newPathsUndecided: false, interruptedApply: false }));
    expect(await previewSpaceApply(ID)).toEqual({ changedPaths: 3, changedBytes: 2048, nestedRepositories: paths, unmerged: { count: 101, paths: ['a.txt'] }, changesRoute: 'open', lastApplied: null, newPaths: 3, newPathsUndecided: false });

    const seen = answer(409, JSON.stringify({ code: 'name_not_allowed_here', message: 'The agent made CON', details: { path: 'CON', rule: 'reserved', other: null } }));
    const refusal = await applySpaceWork(ID, { as: 'changes', removeAfterwards: false }).catch((error: Error) => error);
    expect(refusal).toBeInstanceOf(SpacesRequestError);
    expect(refusal).toMatchObject({ code: 'name_not_allowed_here', status: 409, details: { path: 'CON', other: null } });
    expect(seen[0].method).toBe('POST');

    // Details of a shape this version does not know are dropped, never the refusal itself.
    answer(409, JSON.stringify({ code: 'changes_do_not_apply', message: 'no', details: { path: 7 } }));
    expect(await applySpaceWork(ID, { as: 'changes', removeAfterwards: false }).catch((error: Error) => error)).toMatchObject({ code: 'changes_do_not_apply', details: {} });
  });
});
