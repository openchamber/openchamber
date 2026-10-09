import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getSpaceMark, hasIsolatedSpaces, refreshSpacesJourney, spaceMarkSchema, spacesOfProject, spacesWithoutProject, useSpacesStore, type SpaceMark } from './spaces-store';
import type { SpaceEntry } from './spaces-api';

const ID = 'a1b2c3d4e5f6';
const mark = (state: SpaceMark['state'] = 'complete'): SpaceMark => ({ id: ID, name: 'One', state, projectDirectory: '/home/me/app', directory: `/spaces/${ID}/app` });

describe('useSpacesStore', () => {
  beforeEach(() => useSpacesStore.getState().resetForRuntimeSwitch());

  test('holds the marks of the last complete list, and answers whether any space exists', () => {
    expect(hasIsolatedSpaces()).toBe(false);
    useSpacesStore.getState().applyMarks([mark()]);
    expect(hasIsolatedSpaces()).toBe(true);
    expect(getSpaceMark(ID)?.name).toBe('One');
    useSpacesStore.getState().applyMarks([]);
    expect(hasIsolatedSpaces()).toBe(false);
  });

  test('a lost stream marks the space stale; a stream back changes nothing until a read answers', () => {
    useSpacesStore.getState().applyMarks([mark()]);
    useSpacesStore.getState().noteStream(ID, 'disconnected');
    expect(getSpaceMark(ID)?.state).toBe('stale');
    useSpacesStore.getState().noteStream(ID, 'connected');
    expect(getSpaceMark(ID)?.state).toBe('stale');
    useSpacesStore.getState().noteReachable(ID);
    expect(getSpaceMark(ID)?.state).toBe('complete');
    // An unknown space is not invented by a stream announcement.
    useSpacesStore.getState().noteStream('0f0f0f0f0f0f', 'disconnected');
    expect(useSpacesStore.getState().spaces.size).toBe(1);
  });

  test('a runtime switch forgets every space', () => {
    useSpacesStore.getState().applyMarks([mark('partial')]);
    useSpacesStore.getState().resetForRuntimeSwitch();
    expect(hasIsolatedSpaces()).toBe(false);
  });

  test('parses the mark the host sends, with its optional fields defaulted', () => {
    expect(spaceMarkSchema.parse({ id: ID, state: 'unknown' })).toEqual({ id: ID, name: '', state: 'unknown', projectDirectory: null, directory: null });
    expect(spaceMarkSchema.safeParse({ id: 'short', state: 'complete' }).success).toBe(false);
    expect(spaceMarkSchema.safeParse({ id: ID, state: 'weird' }).success).toBe(false);
  });
});

describe('the journey list and creation progress', () => {
  const originalFetch = globalThis.fetch;
  const entry = (overrides: Partial<SpaceEntry> = {}): SpaceEntry => ({
    id: ID,
    name: 'One',
    placeId: 'docker',
    projectDirectory: '/home/me/app',
    projectFolder: { path: '/home/me/app', found: true },
    directory: `/spaces/${ID}/app`,
    state: 'preparing',
    stoppedIdle: false,
    step: 'checking_place',
    failure: null,
    network: { mode: 'allowlist', domains: [] },
    grants: [],
    access: null,
    needsAccess: [],
    damage: null,
    setup: null,
    ...overrides,
  });
  // One list answer the test releases by hand, so a progress event can land while the read is out.
  const heldList = () => {
    let release: (spaces: SpaceEntry[]) => void = () => undefined;
    const answered = new Promise<SpaceEntry[]>((resolve) => { release = resolve; });
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify({ spaces: await answered }), { status: 200 }),
      originalFetch,
    );
    return (spaces: SpaceEntry[]) => release(spaces);
  };

  beforeEach(() => useSpacesStore.getState().resetForRuntimeSwitch());
  afterEach(() => { globalThis.fetch = originalFetch; });

  test('a step moves a known space on; an unknown space is not invented', () => {
    useSpacesStore.getState().applyJourney([entry()], 0);
    expect(useSpacesStore.getState().noteProgress({ spaceId: ID, step: 'bringing_code', failure: null })).toBe(true);
    expect(useSpacesStore.getState().journey?.get(ID)).toMatchObject({ state: 'preparing', step: 'bringing_code' });
    expect(useSpacesStore.getState().noteProgress({ spaceId: '0f0f0f0f0f0f', step: 'creating', failure: null })).toBe(false);
    expect(useSpacesStore.getState().journey?.size).toBe(1);
  });

  test('ready runs the space; failed keeps the failure to show', () => {
    useSpacesStore.getState().applyJourney([entry()], 0);
    useSpacesStore.getState().noteProgress({ spaceId: ID, step: 'ready', failure: null });
    expect(useSpacesStore.getState().journey?.get(ID)).toMatchObject({ state: 'running', step: null });
    useSpacesStore.getState().noteProgress({ spaceId: ID, step: 'failed', failure: { code: 'place_unavailable', message: 'Docker is not running.' } });
    expect(useSpacesStore.getState().journey?.get(ID)).toMatchObject({ state: 'failed', failure: { code: 'place_unavailable' } });
  });

  test('a step announced while a read is out wins over that read\'s older answer', async () => {
    useSpacesStore.getState().applyJourney([entry()], 0);
    const release = heldList();
    const read = refreshSpacesJourney();
    useSpacesStore.getState().noteProgress({ spaceId: ID, step: 'bringing_code', failure: null });
    release([entry({ step: 'creating' })]);
    await read;
    expect(useSpacesStore.getState().journey?.get(ID)?.step).toBe('bringing_code');
  });

  test('a read that a runtime switch overtook is dropped', async () => {
    const release = heldList();
    const read = refreshSpacesJourney();
    useSpacesStore.getState().resetForRuntimeSwitch();
    release([entry()]);
    await read;
    expect(useSpacesStore.getState().journey).toBeNull();
  });

  test('a failed read keeps the last list', async () => {
    useSpacesStore.getState().applyJourney([entry()], 0);
    globalThis.fetch = Object.assign(
      async () => new Response(JSON.stringify({ code: 'place_unavailable', message: 'down' }), { status: 502 }),
      originalFetch,
    );
    expect(await refreshSpacesJourney().catch((error: Error) => error)).toMatchObject({ code: 'place_unavailable' });
    expect(useSpacesStore.getState().journey?.get(ID)?.name).toBe('One');
  });
});

describe('the grant dialog and access given through it', () => {
  beforeEach(() => useSpacesStore.getState().resetForRuntimeSwitch());

  test('a provider given in the dialog leaves the failures of the creation', () => {
    const failure = (provider: string) => ({ provider, code: 'secret_source_missing', message: 'not set' });
    useSpacesStore.getState().noteCreationAccess(ID, { kind: 'failed', failures: [failure('openai'), failure('anthropic')] });
    useSpacesStore.getState().noteProviderGranted(ID, 'openai');
    expect(useSpacesStore.getState().creationAccess.get(ID)).toEqual({ kind: 'failed', failures: [failure('anthropic')] });
    useSpacesStore.getState().noteProviderGranted(ID, 'anthropic');
    expect(useSpacesStore.getState().creationAccess.has(ID)).toBe(false);
  });

  test('a grant just given survives a read of the list that began before it', () => {
    const grant = { kind: 'model' as const, id: 'openai', provider: 'openai', upstream: 'https://api.openai.com/v1', source: { kind: 'typed' as const }, url: 'http://gatekeeper:8080/model/openai' };
    const running: SpaceEntry = {
      id: ID, name: 'One', placeId: 'docker', projectDirectory: '/home/me/app', directory: `/spaces/${ID}/app`, projectFolder: { path: '/home/me/app', found: true }, state: 'running', stoppedIdle: false, step: null,
      failure: null, network: { mode: 'allowlist', domains: [] }, grants: [], access: 'needs_access', needsAccess: ['openai'], damage: null, setup: null,
    };
    useSpacesStore.getState().applyJourney([running], 0);
    const before = useSpacesStore.getState().progressRevision;
    useSpacesStore.getState().noteGrantGiven(ID, grant);
    expect(useSpacesStore.getState().journey?.get(ID)).toMatchObject({ grants: [grant], needsAccess: [] });
    // The older read answers last, without the grant: the grant stays.
    useSpacesStore.getState().applyJourney([running], before);
    expect(useSpacesStore.getState().journey?.get(ID)?.grants).toEqual([grant]);
    // A read that began after it is the host's word again.
    useSpacesStore.getState().applyJourney([{ ...running, needsAccess: [] }], useSpacesStore.getState().progressRevision);
    expect(useSpacesStore.getState().journey?.get(ID)?.grants).toEqual([]);
  });

  test('opens on a space and a provider, and a runtime switch closes it', () => {
    useSpacesStore.getState().openAccessDialog(ID, 'openai');
    expect(useSpacesStore.getState().accessDialog).toEqual({ spaceId: ID, providerId: 'openai' });
    useSpacesStore.getState().openAccessDialog(ID);
    expect(useSpacesStore.getState().accessDialog).toEqual({ spaceId: ID, providerId: null });
    useSpacesStore.getState().resetForRuntimeSwitch();
    expect(useSpacesStore.getState().accessDialog).toBeNull();
  });
});

describe('the lists of spaces', () => {
  const space = (id: string, projectDirectory: string | null): SpaceEntry => ({
    id, name: id, placeId: 'docker', projectDirectory, directory: projectDirectory ? `/spaces/${id}/app` : null, projectFolder: { path: projectDirectory ?? '/home/me/old', found: true },
    state: 'running', stoppedIdle: false, step: null, failure: null, network: null, grants: [], access: null, needsAccess: [], damage: null, setup: null,
  });
  const journey = new Map([
    ['aaaaaaaaaaaa', space('aaaaaaaaaaaa', '/home/me/app')],
    ['bbbbbbbbbbbb', space('bbbbbbbbbbbb', '/home/me/other')],
    ['cccccccccccc', space('cccccccccccc', null)],
    ['dddddddddddd', space('dddddddddddd', '/home/me/app/')],
  ]);

  test('a project lists its own spaces in the host\'s order, whatever the path\'s trailing slash', () => {
    expect(spacesOfProject(journey, '/home/me/app').map((entry) => entry.id)).toEqual(['aaaaaaaaaaaa', 'dddddddddddd']);
    expect(spacesOfProject(journey, '/home/me/app/').map((entry) => entry.id)).toEqual(['aaaaaaaaaaaa', 'dddddddddddd']);
    expect(spacesOfProject(journey, '/home/me/none')).toEqual([]);
    // A space with no project is no project's, not the one whose path is empty.
    expect(spacesOfProject(journey, '')).toEqual([]);
  });

  test('the spaces without a project are the ones the host resolved to none', () => {
    expect(spacesWithoutProject(journey).map((entry) => entry.id)).toEqual(['cccccccccccc']);
  });
});
