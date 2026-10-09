import { afterEach, describe, expect, test } from 'bun:test';

import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { applyRefusalOf, applySpace, branchNameOfSpace, closesChanges, isAgentWorkingInSpace } from './space-apply';
import { SpacesRequestError, type SpaceEntry } from './spaces-api';
import { useSpacesStore } from './spaces-store';

const ID = 'a1b2c3d4e5f6';
const originalFetch = globalThis.fetch;
const originalLoadSessions = useGlobalSessionsStore.getState().loadSessions;

const entry: SpaceEntry = {
  id: ID,
  name: 'Fix login',
  placeId: 'docker',
  projectDirectory: '/home/me/app',
  projectFolder: { path: '/home/me/app', found: true },
  directory: `/spaces/${ID}/app`,
  state: 'running',
  stoppedIdle: false,
  step: null,
  failure: null,
  network: { mode: 'allowlist', domains: [] },
  grants: [],
  access: null,
  needsAccess: [],
  damage: null,
  setup: null,
};

// Answers the apply route with `apply`, the list route with the space or without it after a removal.
const serve = (apply: { status: number; body: object }, listed: SpaceEntry[]) => {
  const bodies: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/apply')) {
      bodies.push(String(init?.body ?? ''));
      return new Response(JSON.stringify(apply.body), { status: apply.status, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ spaces: listed }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }, originalFetch);
  useGlobalSessionsStore.setState({ loadSessions: async () => ({ activeSessions: [], archivedSessions: [] }) });
  return bodies;
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  useGlobalSessionsStore.setState({ loadSessions: originalLoadSessions });
  useSpacesStore.getState().resetForRuntimeSwitch();
});

describe('the branch an apply suggests', () => {
  test('is the space name as git takes it', () => {
    expect(branchNameOfSpace('cosmic-dolphin')).toBe('cosmic-dolphin');
    expect(branchNameOfSpace('Fix login')).toBe('fix-login');
    expect(branchNameOfSpace('  Café  crème ')).toBe('cafe-creme');
    expect(branchNameOfSpace('feature//x..y')).toBe('feature/x.y');
    expect(branchNameOfSpace('-lead.lock')).toBe('lead');
    expect(branchNameOfSpace('???')).toBe('space');
    expect(branchNameOfSpace('')).toBe('space');
  });
});

describe('what an apply was refused for', () => {
  const refused = (code: string, details = {}) => applyRefusalOf(new SpacesRequestError(code, 'from the host', 409, details), 'fix-login');

  test('the refusals that close the way of uncommitted changes turn the dialog to the branch', () => {
    for (const code of ['changes_do_not_apply', 'changes_route_closed', 'changes_blocked_by_link']) {
      expect(refused(code)).toEqual({ kind: 'changes_closed' });
    }
    expect(refused('changes_undecided')).toEqual({ kind: 'undecided' });
    for (const code of ['changes_undecided', 'changes_do_not_apply']) expect(closesChanges(refused(code))).toBe(true);
    expect(refused('changes_partly_applied')).toEqual({ kind: 'partly_applied' });
    expect(closesChanges(refused('changes_route_closed'))).toBe(true);
    expect(closesChanges(refused('changes_partly_applied'))).toBe(true);
  });

  test('keeps the cases whose next step differs: part thrown away names the files in the way of the branch', () => {
    const stillThere = { count: 2, paths: ['src/a.js', 'src/b.js'] };
    const partly = refused('changes_do_not_apply', { thrownAway: { count: 1, paths: ['README.md'] }, stillThere });
    expect(partly).toEqual({ kind: 'part_thrown_away', stillThere });
    expect(refused('changes_do_not_apply', { ignoredInTheWay: { count: 1, paths: ['.env.local'] } })).toEqual({ kind: 'ignored_in_the_way', path: '.env.local' });
    expect(refused('changes_do_not_apply', { filteredInTheWay: { count: 1, paths: ['big.bin'] } })).toEqual({ kind: 'filtered_in_the_way' });
    for (const refusal of [partly, refused('changes_do_not_apply', { filteredInTheWay: { count: 1, paths: ['x'] } })]) expect(closesChanges(refusal)).toBe(true);
  });

  test('the refusals that leave that way open do not', () => {
    expect(refused('changes_too_large')).toEqual({ kind: 'too_large' });
    expect(refused('patch_not_possible')).toEqual({ kind: 'too_large' });
    expect(refused('name_not_allowed_here', { path: 'CON.txt' })).toEqual({ kind: 'name_not_allowed', path: 'CON.txt' });
    expect(refused('case_only_rename', { path: 'README.md', other: 'Readme.md' })).toEqual({ kind: 'case_only_rename', path: 'README.md', other: 'Readme.md' });
    for (const code of ['changes_too_large', 'name_not_allowed_here', 'case_only_rename', 'space_not_running']) {
      expect(closesChanges(refused(code, { path: 'a', other: 'b' }))).toBe(false);
    }
  });

  test('names the branch in the way, the one git cannot keep beside it before the one asked for', () => {
    expect(refused('branch_exists')).toEqual({ kind: 'branch_exists', branch: 'fix-login' });
    expect(refused('branch_exists', { branch: 'fix' })).toEqual({ kind: 'branch_exists', branch: 'fix' });
    expect(refused('invalid_branch_name')).toEqual({ kind: 'invalid_branch' });
  });

  test('a refusal without the file it is about, or one the dialog does not know, keeps the host\'s words', () => {
    expect(refused('name_not_allowed_here')).toEqual({ kind: 'other', failure: { code: 'name_not_allowed_here', message: 'from the host' } });
    expect(refused('code_out_failed')).toEqual({ kind: 'other', failure: { code: 'code_out_failed', message: 'from the host' } });
    expect(applyRefusalOf(new Error('offline'), null)).toEqual({ kind: 'other', failure: { code: 'space_request_failed', message: 'offline' } });
  });
});

describe('whether an agent still works in the space', () => {
  const index = (entries: [string, string][], active: string[]) => ({ activeSessionIds: new Set(active), statusById: new Map(entries.map(([id, directory]) => [id, { directory }])) });

  test('counts only working sessions inside that space', () => {
    expect(isAgentWorkingInSpace(index([['s1', `/spaces/${ID}/app`]], ['s1']), ID)).toBe(true);
    expect(isAgentWorkingInSpace(index([['s1', `/spaces/${ID}`]], ['s1']), ID)).toBe(true);
    expect(isAgentWorkingInSpace(index([['s1', `/spaces/${ID}/app`]], []), ID)).toBe(false);
    expect(isAgentWorkingInSpace(index([['s1', '/spaces/0f0f0f0f0f0f/app'], ['s2', '/home/me/app']], ['s1', 's2']), ID)).toBe(false);
    expect(isAgentWorkingInSpace(index([['s1', `/spaces/${ID}0/app`]], ['s1']), ID)).toBe(false);
  });
});

describe('applying', () => {
  test('sends the choice, and forgets a space the host removed afterwards', async () => {
    useSpacesStore.getState().applyJourney([entry], 0);
    useSpacesStore.getState().openApplyDialog(ID);
    const bodies = serve({ status: 200, body: { applied: { status: 'applied', branch: 'fix-login', commit: 'c'.repeat(40) }, removal: { id: ID, removed: true, failures: [] } } }, []);
    const result = await applySpace(ID, { as: 'branch', branch: 'fix-login', removeAfterwards: true });
    expect(result).toMatchObject({ kind: 'applied', outcome: { applied: { branch: 'fix-login' } } });
    expect(JSON.parse(bodies[0])).toEqual({ as: 'branch', branch: 'fix-login', removeAfterwards: true });
    expect(useSpacesStore.getState().applyDialog).toBeNull();
    expect(useSpacesStore.getState().journey?.has(ID)).toBe(false);
  });

  test('keeps a removal that went through in part on the group as a failed delete', async () => {
    useSpacesStore.getState().applyJourney([entry], 0);
    serve({ status: 200, body: { applied: { status: 'applied', appliedPaths: 3 }, removal: { id: ID, removed: false, failures: [{ code: 'docker_failed', message: 'volume busy' }] } } }, [entry]);
    expect(await applySpace(ID, { as: 'changes', removeAfterwards: true })).toMatchObject({ kind: 'applied' });
    expect(useSpacesStore.getState().actions.get(ID)).toEqual({ kind: 'failed', action: 'remove', failure: { code: 'docker_failed', message: 'volume busy' } });
  });

  test('reads a refusal and nothing to apply as refusals, and leaves the space', async () => {
    useSpacesStore.getState().applyJourney([entry], 0);
    serve({ status: 409, body: { code: 'changes_route_closed', message: 'closed', details: null } }, [entry]);
    expect(await applySpace(ID, { as: 'changes', removeAfterwards: true })).toEqual({ kind: 'refused', refusal: { kind: 'changes_closed' } });
    serve({ status: 200, body: { applied: { status: 'nothing_to_apply' }, removal: null } }, [entry]);
    expect(await applySpace(ID, { as: 'changes', removeAfterwards: true })).toEqual({ kind: 'refused', refusal: { kind: 'nothing_to_apply' } });
    expect(useSpacesStore.getState().journey?.has(ID)).toBe(true);
    expect(useSpacesStore.getState().actions.get(ID)).toBeUndefined();
  });
});
