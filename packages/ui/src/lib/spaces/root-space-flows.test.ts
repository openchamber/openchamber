import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { AuthenticationResponseJSON } from '@simplewebauthn/browser';
import type { SpaceEntry } from './spaces-api';
import { getRootStartConfirmation, settleRootStartConfirmation } from './root-start-confirmation';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { startSpaceCreation } from './space-creation';
import { runSpaceAction } from './space-repair';
import { useSpacesStore } from './spaces-store';
import type { RootPasskeyDependencies } from './root-activation';

const id = '012345abcdef';
const origin = 'http://localhost:3000';
const entry: SpaceEntry = {
  id, kind: 'host-root', placeId: 'host-root', name: 'Root task', machine: null,
  projectDirectory: '/project', projectFolder: { path: '/project', found: true }, directory: `/spaces/${id}/project`,
  state: 'running', stoppedIdle: false, step: null, failure: null, network: { mode: 'open', domains: [] },
  grants: [], access: null, needsAccess: [], accessFailures: [], damage: null, setup: null,
};
const assertion: AuthenticationResponseJSON = {
  id: 'key', rawId: 'key', type: 'public-key', clientExtensionResults: {},
  response: { authenticatorData: 'data', clientDataJSON: 'client', signature: 'sig' },
};
const fetch = spyOn(globalThis, 'fetch');
const passkeys: RootPasskeyDependencies = { authenticate: async () => assertion, origin: () => origin };
const authentication = spyOn(passkeys, 'authenticate');
const originalLoad = useGlobalSessionsStore.getState().loadSessions;
let operations: string[];
beforeEach(() => {
  operations = [];
  useSpacesStore.getState().resetForRuntimeSwitch();
  useSessionUIStore.getState().closeNewSessionDraft();
  useGlobalSessionsStore.setState({ loadSessions: async () => ({ activeSessions: [], archivedSessions: [] }) });
  authentication.mockImplementation(async () => { operations.push('passkey'); return assertion; });
  fetch.mockImplementation(async (input, init) => {
    const path = new URL(String(input), origin).pathname;
    if (init?.method === 'POST') operations.push(path);
    if (path.endsWith('root-activation')) return Response.json({ spaceId: id, challenge: 'challenge', expiresAt: 123456, rpID: 'localhost', allowCredentials: [{ id: 'key', label: 'Key', origin }] });
    if (init?.method === 'POST') return Response.json(entry);
    if (path.endsWith('custom-providers')) return Response.json({ providers: [] });
    return Response.json({ spaces: [entry] });
  });
});
afterEach(() => {
  settleRootStartConfirmation(false);
  fetch.mockReset(); authentication.mockReset();
  useSpacesStore.getState().resetForRuntimeSwitch();
  useSessionUIStore.getState().closeNewSessionDraft();
  useGlobalSessionsStore.setState({ loadSessions: originalLoad });
});
const create = () => startSpaceCreation({
  projectId: 'project', request: { projectDirectory: '/project', name: 'Root task', placeId: 'host-root', start: 'clean', network: { mode: 'open', domains: [] } },
  setup: { commands: [], waitBeforeSending: false }, access: [], refusalMessage: 'refused', rootOrigins: [origin], rootPasskey: passkeys,
});

describe('root flows used by the dialog and action surfaces', () => {
  it('creates the draft only after root confirmation succeeds', async () => {
    // Given / When
    await create();
    // Then
    expect(operations).toEqual(['/api/openchamber/spaces/root-activation', 'passkey', '/api/openchamber/spaces']);
    expect(useSpacesStore.getState().journey?.get(id)?.kind).toBe('host-root');
    expect(useSessionUIStore.getState().newSessionDraft.pendingWorktreeRequestId).toBeTruthy();
  });

  it('leaves no group or draft when the creation ceremony is cancelled', async () => {
    // Given
    authentication.mockRejectedValue(new DOMException('Cancelled', 'NotAllowedError'));
    // When / Then
    await expect(create()).rejects.toMatchObject({ code: 'root_activation_cancelled' });
    expect(operations).toEqual(['/api/openchamber/spaces/root-activation']);
    expect(useSpacesStore.getState().journey?.size ?? 0).toBe(0);
    expect(useSessionUIStore.getState().newSessionDraft.pendingWorktreeRequestId).toBeNull();
  });

  it.each(['start', 'restart'] as const)('uses confirmation for the shared %s action', async (action) => {
    // Given
    useSpacesStore.getState().addJourneyEntry({ ...entry, state: action === 'start' ? 'exited' : 'running' });
    // When
    const result = runSpaceAction(id, action, { rootPasskey: passkeys });
    expect(getRootStartConfirmation()).toEqual({ spaceId: id });
    expect(operations).toEqual([]);
    settleRootStartConfirmation(true);
    await result;
    // Then
    expect(operations).toEqual([`/api/openchamber/spaces/${id}/root-activation`, 'passkey', `/api/openchamber/spaces/${id}/${action}`]);
  });

  it('keeps a stopped root space stopped when its visual warning is dismissed', async () => {
    // Given
    useSpacesStore.getState().addJourneyEntry({ ...entry, state: 'exited' });
    fetch.mockResolvedValueOnce(Response.json({ spaces: [{ ...entry, state: 'exited' }] }));
    const result = runSpaceAction(id, 'start', { rootPasskey: passkeys });
    // When
    settleRootStartConfirmation(false);
    await result;
    // Then
    expect(operations).toEqual([]);
    expect(authentication).not.toHaveBeenCalled();
    expect(useSpacesStore.getState().journey?.get(id)?.state).toBe('exited');
    expect(useSpacesStore.getState().actions.get(id)).toMatchObject({ kind: 'failed', failure: { code: 'root_activation_cancelled' } });
  });
});
