import { afterEach, describe, expect, test } from 'bun:test';

import { createSpace, listSpaces, readSpacesSwitch, SpacesRequestError } from './spaces-api';

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
    await createSpace({ projectDirectory: '/home/me/app', name: 'Fix login', start: 'clean', network: { mode: 'open', domains: [] } });
    expect(seen[0]?.method).toBe('POST');
    expect(new URL(seen[0]?.url ?? '').pathname).toBe('/api/openchamber/spaces');
    expect(await seen[0]?.json()).toEqual({ projectDirectory: '/home/me/app', name: 'Fix login', start: 'clean', network: { mode: 'open', domains: [] } });
  });
});
