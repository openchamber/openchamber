import { afterEach, describe, expect, test } from 'bun:test';

import { createSpace, listSpaces, openSpaceDomain, readSpaceIdleStop, readSpaceJournal, readSpaceSetup, readSpacesSwitch, runSpaceSetup, setSpaceIdleStop, SpacesRequestError } from './spaces-api';

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
  placeId: 'local-docker',
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
    await createSpace({ projectDirectory: '/home/me/app', name: 'Fix login', start: 'clean', network: { mode: 'open', domains: [] }, setupCommands: ['npm ci'] });
    expect(seen[0]?.method).toBe('POST');
    expect(new URL(seen[0]?.url ?? '').pathname).toBe('/api/openchamber/spaces');
    expect(await seen[0]?.json()).toEqual({ projectDirectory: '/home/me/app', name: 'Fix login', start: 'clean', network: { mode: 'open', domains: [] }, setupCommands: ['npm ci'] });
  });
});

describe('the journal and opened domains', () => {
  test('reads the setup commands\' run, none from a host that does not know them, and runs them again with a POST', async () => {
    answer(200, JSON.stringify({ spaces: [entry] }));
    expect((await listSpaces())[0]?.setup).toBeNull();
    const failed = { state: 'failed', index: 1, total: 2, command: 'npm ci', exitCode: 1, timedOut: false };
    answer(200, JSON.stringify({ spaces: [{ ...entry, setup: failed }] }));
    expect((await listSpaces())[0]?.setup).toEqual(failed);
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
});
