import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { isSpaceActionUnavailable, isSpaceApplicable, runSpaceAction, spaceConditionOf, spaceMenuActionsOf } from './space-repair';
import { getSharedTrustConfirmationSnapshot, settleSharedTrustConfirmation } from '@/lib/sharedTrustConfirmation';
import type { SpaceEntry } from './spaces-api';
import { useSpacesStore, type SpaceMark } from './spaces-store';

const ID = 'a1b2c3d4e5f6';
const originalFetch = globalThis.fetch;
const originalLoadSessions = useGlobalSessionsStore.getState().loadSessions;

const entry = (change: Partial<SpaceEntry> = {}): SpaceEntry => ({
  id: ID,
  name: 'Fix login',
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
  ...change,
});
const mark = (state: SpaceMark['state']): SpaceMark => ({ id: ID, name: 'Fix login', state, projectDirectory: '/home/me/app', directory: `/spaces/${ID}/app` });

describe('whether a space\'s work can be applied', () => {
  test('from a running space, or a stopped one a start brings back', () => {
    expect(isSpaceApplicable(entry())).toBe(true);
    expect(isSpaceApplicable(entry({ state: 'exited' }))).toBe(true);
    expect(isSpaceApplicable(entry({ damage: 'gatekeeper_gone' }))).toBe(true);
    expect(isSpaceApplicable(entry({ state: 'exited', damage: 'gatekeeper_gone' }))).toBe(false);
    for (const state of ['preparing', 'failed', 'missing'] as const) expect(isSpaceApplicable(entry({ state }))).toBe(false);
    expect(isSpaceApplicable(undefined)).toBe(false);
    // The folder the space was made for is gone from the host: the work has nowhere to go.
    expect(isSpaceApplicable(entry({ projectDirectory: null, projectFolder: { path: '/home/me/app', found: false } }))).toBe(false);
    // Not looked at, or a host before 5e-3 that names none: the apply dialog decides.
    expect(isSpaceApplicable(entry({ projectDirectory: null, projectFolder: { path: null, found: null } }))).toBe(true);
  });
});

describe('the state of a space', () => {
  test('says nothing for a space that runs and answers, or one the creation line covers', () => {
    expect(spaceConditionOf(entry(), mark('complete'), undefined)).toBeNull();
    expect(spaceConditionOf(entry({ state: 'preparing', step: 'creating' }), undefined, undefined)).toBeNull();
    expect(spaceConditionOf(entry({ state: 'failed' }), undefined, undefined)).toBeNull();
    expect(spaceConditionOf(undefined, mark('stale'), undefined)).toBeNull();
  });

  test('names what the host lists, the lost gatekeeper before a stop, a stop before a repairable damage', () => {
    expect(spaceConditionOf(entry({ state: 'missing' }), undefined, undefined)).toEqual({ kind: 'container_gone' });
    expect(spaceConditionOf(entry({ state: 'exited', damage: 'gatekeeper_gone' }), undefined, undefined)).toEqual({ kind: 'gatekeeper_gone' });
    expect(spaceConditionOf(entry({ state: 'exited' }), undefined, undefined)).toEqual({ kind: 'stopped' });
    expect(spaceConditionOf(entry({ state: 'exited', stoppedIdle: true }), mark('stale'), undefined)).toEqual({ kind: 'stopped_idle' });
    expect(spaceMenuActionsOf(entry({ state: 'exited', stoppedIdle: true }))).toEqual(['start', 'remove']);
    expect(spaceConditionOf(entry({ damage: 'repairable' }), mark('stale'), undefined)).toEqual({ kind: 'damaged' });
    expect(spaceConditionOf(entry(), mark('stale'), undefined)).toEqual({ kind: 'not_answering' });
    expect(spaceConditionOf(entry(), mark('unknown'), undefined)).toEqual({ kind: 'not_answering' });
    expect(spaceConditionOf(entry(), mark('partial'), undefined)).toBeNull();
  });

  test('an action under way or failed in this window comes first', () => {
    expect(spaceConditionOf(entry({ state: 'exited' }), undefined, { kind: 'running', action: 'start' })).toEqual({ kind: 'busy', action: 'start' });
    const failure = { code: 'gatekeeper_missing', message: 'gone' };
    expect(spaceConditionOf(entry({ state: 'exited' }), undefined, { kind: 'failed', action: 'start', failure })).toEqual({ kind: 'action_failed', action: 'start', failure });
  });

  test('a failure gives way when the host lists a state its action no longer fits', () => {
    const refused = { code: 'space_not_running', message: 'stopped' };
    // A restart offered for a space that did not answer, refused because it had stopped.
    expect(spaceConditionOf(entry({ state: 'exited' }), mark('stale'), { kind: 'failed', action: 'restart', failure: refused })).toEqual({ kind: 'stopped' });
    // A start refused because the gatekeeper is gone leaves the way to delete it.
    expect(spaceConditionOf(entry({ state: 'exited', damage: 'gatekeeper_gone' }), undefined, { kind: 'failed', action: 'start', failure: refused })).toEqual({ kind: 'gatekeeper_gone' });
  });
});

describe('the actions of a space', () => {
  test('offers the restarts only for a running space whose gatekeeper can come back', () => {
    expect(spaceMenuActionsOf(entry())).toEqual(['restart_opencode', 'restart', 'setup', 'stop', 'remove']);
    expect(spaceMenuActionsOf(entry({ damage: 'repairable' }))).toEqual(['restart_opencode', 'restart', 'setup', 'stop', 'remove']);
    expect(spaceMenuActionsOf(entry({ damage: 'gatekeeper_gone' }))).toEqual(['stop', 'remove']);
    expect(spaceMenuActionsOf(entry({ state: 'exited' }))).toEqual(['start', 'remove']);
    expect(spaceMenuActionsOf(entry({ state: 'exited', damage: 'gatekeeper_gone' }))).toEqual(['remove']);
    expect(spaceMenuActionsOf(entry({ state: 'missing' }))).toEqual(['remove']);
    expect(spaceMenuActionsOf(entry({ state: 'preparing' }))).toEqual([]);
    expect(spaceMenuActionsOf(undefined)).toEqual([]);
  });

  test('offers the setup commands again only while they do not run', () => {
    expect(isSpaceActionUnavailable(entry({ setup: { state: 'running', index: 0, total: 2, command: 'npm ci' } }), 'setup')).toBe(true);
    expect(isSpaceActionUnavailable(entry({ setup: { state: 'running', index: 0, total: 2, command: 'npm ci' } }), 'restart')).toBe(false);
    expect(isSpaceActionUnavailable(entry({ setup: { state: 'failed', index: 0, total: 2, command: 'npm ci', exitCode: 1, timedOut: false, startedAt: null, finishedAt: null } }), 'setup')).toBe(false);
    expect(isSpaceActionUnavailable(entry(), 'setup')).toBe(false);
  });

  describe('running one', () => {
    let requests: string[] = [];
    // The host's answers: the action's own, then the list read after it.
    const host = (answer: (path: string) => Response | Promise<Response>) => {
      requests = [];
      globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input), 'http://host').pathname;
        requests.push(`${init?.method ?? 'GET'} ${path}`);
        return answer(path);
      }, originalFetch);
    };
    const listAnswer = (spaces: SpaceEntry[]) => new Response(JSON.stringify({ spaces }), { status: 200 });

    beforeEach(() => useSpacesStore.getState().resetForRuntimeSwitch());
    afterEach(() => {
      globalThis.fetch = originalFetch;
      useGlobalSessionsStore.setState({ loadSessions: originalLoadSessions });
    });

    test('restarts, reads the list again, and marks the space reachable once the server inside is ready', async () => {
      useSpacesStore.getState().applyMarks([mark('stale')]);
      host((path) => (path.endsWith('/restart') ? new Response(JSON.stringify(entry()), { status: 200 }) : listAnswer([entry()])));
      const run = runSpaceAction(ID, 'restart');
      expect(useSpacesStore.getState().actions.get(ID)).toEqual({ kind: 'running', action: 'restart' });
      await run;
      expect(requests).toEqual([`POST /api/openchamber/spaces/${ID}/restart`, 'GET /api/openchamber/spaces']);
      expect(useSpacesStore.getState().actions.has(ID)).toBe(false);
      expect(useSpacesStore.getState().spaces.get(ID)?.state).toBe('complete');
    });

    test('keeps a refusal with its code for the status line, and reads the list all the same', async () => {
      host((path) => (path.endsWith('/start')
        ? new Response(JSON.stringify({ code: 'gatekeeper_missing', message: 'gone' }), { status: 409 })
        : listAnswer([entry({ state: 'exited', damage: 'gatekeeper_gone' })])));
      await runSpaceAction(ID, 'start');
      expect(useSpacesStore.getState().actions.get(ID)).toEqual({ kind: 'failed', action: 'start', failure: { code: 'gatekeeper_missing', message: 'gone' } });
      expect(useSpacesStore.getState().journey?.get(ID)?.damage).toBe('gatekeeper_gone');
    });

    test('keeps nothing of an action that a runtime switch overtook', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      host((path) => (path.endsWith('/start') ? held.then(() => new Response(JSON.stringify({ code: 'space_busy', message: 'busy' }), { status: 409 })) : listAnswer([])));
      const run = runSpaceAction(ID, 'start');
      useSpacesStore.getState().resetForRuntimeSwitch();
      release();
      await run;
      expect(useSpacesStore.getState().actions.size).toBe(0);
    });

    test('runs one action per space at a time in this window', async () => {
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => { release = resolve; });
      host((path) => (path.endsWith('/stop') ? held.then(() => new Response(JSON.stringify(entry({ state: 'exited' })), { status: 200 })) : listAnswer([])));
      const first = runSpaceAction(ID, 'stop');
      await runSpaceAction(ID, 'restart');
      release();
      await first;
      expect(requests.filter((request) => request.startsWith('POST'))).toEqual([`POST /api/openchamber/spaces/${ID}/stop`]);
    });

    test('a removal that left something behind is a failure; one that went through closes what was open on the space and reads the session list', async () => {
      // The session list's own load, counted: its mark is what keeps a group in the sidebar.
      let reloads = 0;
      useGlobalSessionsStore.setState({ loadSessions: async () => { reloads += 1; return { activeSessions: [], archivedSessions: [] }; } });
      useSpacesStore.getState().openAccessDialog(ID);
      host((path) => (path.endsWith(ID)
        ? new Response(JSON.stringify({ id: ID, removed: false, failures: [{ code: 'space_remove_incomplete', message: 'volume busy' }] }), { status: 200 })
        : listAnswer([entry()])));
      await runSpaceAction(ID, 'remove');
      expect(useSpacesStore.getState().actions.get(ID)).toMatchObject({ kind: 'failed', action: 'remove', failure: { code: 'space_remove_incomplete' } });
      expect(useSpacesStore.getState().accessDialog?.spaceId).toBe(ID);
      expect(reloads).toBe(0);

      host((path) => (path.endsWith(ID) ? new Response(JSON.stringify({ id: ID, removed: true, failures: [] }), { status: 200 }) : listAnswer([])));
      await runSpaceAction(ID, 'remove');
      expect(useSpacesStore.getState().actions.has(ID)).toBe(false);
      expect(useSpacesStore.getState().accessDialog).toBeNull();
      expect(reloads).toBe(1);
    });

    test('a delete whose chats could not be saved opens the confirmation again; "Delete anyway" says so, and saved chats are announced', async () => {
      useGlobalSessionsStore.setState({ loadSessions: async () => ({ activeSessions: [], archivedSessions: [] }) });
      useSpacesStore.getState().applyJourney([entry({ name: 'Fix login' })], 0);
      const asked: string[] = [];
      host((path) => {
        if (!path.endsWith(ID)) return listAnswer([entry({ name: 'Fix login' })]);
        return new Response(JSON.stringify({ code: 'chats_not_saved', message: 'not saved', details: { tooLarge: ['Big one'], failed: 0 } }), { status: 409 });
      });
      await runSpaceAction(ID, 'remove');
      expect(useSpacesStore.getState().actions.has(ID)).toBe(false);
      expect(useSpacesStore.getState().deleteDialog).toBe(ID);
      expect(useSpacesStore.getState().deleteUnsaved).toEqual({ tooLarge: ['Big one'], failed: 0 });

      globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), 'http://host');
        asked.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
        return url.pathname.endsWith(ID)
          ? new Response(JSON.stringify({ id: ID, removed: true, failures: [], chats: { saved: 1 } }), { status: 200 })
          : listAnswer([]);
      }, originalFetch);
      useSpacesStore.getState().closeDeleteDialog();
      await runSpaceAction(ID, 'remove', { deleteUnsavedChats: true });
      expect(asked[0]).toBe(`DELETE /api/openchamber/spaces/${ID}?unsavedChats=delete`);
      expect(useSpacesStore.getState().archivedNotice).toBe('Fix login');
    });

    // The project's setup as the host's project route answers it: personal commands only, so no trust prompt.
    const projectSetup = (commands: string[]) => ({
      trust: { hash: null, trusted: true }, setupWorktree: commands, setupWorktreeWait: false, projectActions: [], projectActionsPrimaryId: null, draftStarters: [],
      shared: { status: 'missing', path: '.openchamber/project.json', setupWorktree: [], setupWorktreeWait: null, projectActions: [], draftStarters: [], plansDir: null },
      personal: { setupWorktree: commands, setupWorktreeWait: null, setupWorktreeMode: 'append', projectActions: [], projectActionsPrimaryId: null, draftStarters: [], hiddenSharedActionIds: [], sharedTrust: null },
    });

    test('runs the setup commands again as the project has them now', async () => {
      useSpacesStore.getState().applyJourney([entry()], 0);
      const bodies: unknown[] = [];
      host((path) => {
        if (path.startsWith('/api/projects/')) return new Response(JSON.stringify(projectSetup(['npm ci'])), { status: 200 });
        if (path.endsWith('/setup')) return new Response(JSON.stringify(entry({ setup: { state: 'running', index: 0, total: 1, command: 'npm ci' } })), { status: 200 });
        return listAnswer([entry()]);
      });
      const originalFetchWithBodies = globalThis.fetch;
      globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith('/setup')) bodies.push(JSON.parse(String(init?.body)));
        return originalFetchWithBodies(input, init);
      }, originalFetch);
      await runSpaceAction(ID, 'setup');
      expect(requests.filter((request) => request.startsWith('POST'))).toEqual([`POST /api/openchamber/spaces/${ID}/setup`]);
      expect(bodies).toEqual([{ commands: ['npm ci'] }]);
      expect(useSpacesStore.getState().actions.has(ID)).toBe(false);
    });

    test('says so when the project has no setup commands, and asks the space nothing', async () => {
      useSpacesStore.getState().applyJourney([entry()], 0);
      host((path) => (path.startsWith('/api/projects/') ? new Response(JSON.stringify(projectSetup([])), { status: 200 }) : listAnswer([entry()])));
      await runSpaceAction(ID, 'setup');
      expect(requests.some((request) => request.startsWith('POST'))).toBe(false);
      expect(useSpacesStore.getState().actions.get(ID)).toMatchObject({ kind: 'failed', action: 'setup', failure: { code: 'space_setup_no_commands' } });
    });

    test('tells a skipped trust prompt apart from a project with no setup commands', async () => {
      useSpacesStore.getState().applyJourney([entry()], 0);
      // Shared commands the user has not trusted, no personal ones: the prompt opens, and "skip" leaves nothing.
      const untrusted = { ...projectSetup([]), trust: { hash: 'sha256:x', trusted: false }, setupWorktree: ['npm ci'], shared: { ...projectSetup([]).shared, status: 'ok', setupWorktree: ['npm ci'] } };
      host((path) => (path.startsWith('/api/projects/') ? new Response(JSON.stringify(untrusted), { status: 200 }) : listAnswer([entry()])));
      const run = runSpaceAction(ID, 'setup');
      for (let i = 0; i < 50 && !getSharedTrustConfirmationSnapshot(); i += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
      expect(getSharedTrustConfirmationSnapshot()?.runsIn).toBe('space');
      settleSharedTrustConfirmation('skip');
      await run;
      expect(requests.some((request) => request.startsWith('POST'))).toBe(false);
      expect(useSpacesStore.getState().actions.get(ID)).toMatchObject({ kind: 'failed', action: 'setup', failure: { code: 'space_setup_shared_skipped' } });
    });
  });
});
