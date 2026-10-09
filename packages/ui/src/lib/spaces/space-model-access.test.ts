import { beforeEach, describe, expect, test } from 'bun:test';

import { noteSpaceModelAccess, resetSpaceModelAccess, spaceModelRefusal } from './space-model-access';
import type { SpaceEntry } from './spaces-api';
import { useSpacesStore } from './spaces-store';

const ID = 'a1b2c3d4e5f6';
const DIRECTORY = `/spaces/${ID}/app`;
const anthropic = { kind: 'model' as const, id: 'anthropic', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', source: { kind: 'typed' as const }, url: 'http://gatekeeper:8080/model/anthropic' };

const running = (change: Partial<SpaceEntry> = {}): SpaceEntry => ({
  id: ID,
  name: 'Fix login',
  placeId: 'docker',
  projectDirectory: '/home/me/app',
  projectFolder: { path: '/home/me/app', found: true },
  directory: DIRECTORY,
  state: 'running',
  stoppedIdle: false,
  step: null,
  failure: null,
  network: { mode: 'allowlist', domains: [] },
  grants: [anthropic],
  access: 'granted',
  needsAccess: [],
  damage: null,
  setup: null,
  ...change,
});

const listed = (entry: SpaceEntry) => useSpacesStore.getState().applyJourney([entry], useSpacesStore.getState().progressRevision);
const session = { requestId: null, directory: DIRECTORY };

describe('spaceModelRefusal', () => {
  beforeEach(() => {
    useSpacesStore.getState().resetForRuntimeSwitch();
    resetSpaceModelAccess();
  });

  test('a running space is judged by the list, in any window', () => {
    listed(running());
    expect(spaceModelRefusal(session, 'anthropic')).toBeNull();
    expect(spaceModelRefusal(session, 'openai')).toEqual({ spaceId: ID, providerId: 'openai', reason: 'not_granted' });
    // A host directory is never a space's business.
    expect(spaceModelRefusal({ requestId: null, directory: '/home/me/app' }, 'openai')).toBeNull();
  });

  test('a key the gatekeeper lost after a restart needs the user again', () => {
    listed(running({ access: 'needs_access', needsAccess: ['anthropic'] }));
    expect(spaceModelRefusal(session, 'anthropic')).toEqual({ spaceId: ID, providerId: 'anthropic', reason: 'needs_again' });
  });

  test('a space with no grant at all refuses every provider, as after a reload during its creation', () => {
    listed(running({ grants: [], access: null }));
    expect(spaceModelRefusal(session, 'anthropic')).toEqual({ spaceId: ID, providerId: 'anthropic', reason: 'not_granted' });
  });

  test('never refuses a provider the grant dialog cannot give a key for, when the space can reach it', () => {
    listed(running({ grants: [], access: null, network: { mode: 'open', domains: [] } }));
    expect(spaceModelRefusal(session, 'opencode')).toBeNull();
    expect(spaceModelRefusal(session, 'github-copilot')).toBeNull();
    listed(running({ grants: [], access: null, network: { mode: 'allowlist', domains: ['opencode.ai'] } }));
    expect(spaceModelRefusal(session, 'opencode')).toBeNull();
  });

  test("refuses OpenCode's own provider in a space that allows only chosen addresses without its name, while it is made and once it runs", () => {
    const blocked = { spaceId: ID, providerId: 'opencode', reason: 'domain_blocked', domain: 'opencode.ai' };
    noteSpaceModelAccess({ requestId: 'r1', directory: DIRECTORY }, ['anthropic']);
    listed(running({ state: 'preparing', step: 'creating', grants: [], access: null }));
    expect(spaceModelRefusal({ requestId: 'r1', directory: '/home/me/app' }, 'opencode')).toEqual(blocked);
    listed(running());
    expect(spaceModelRefusal(session, 'opencode')).toEqual(blocked);
    // A provider whose address nobody knows is not refused by the network; a space not listed yet, or
    // one whose network the host could not read, refuses nothing.
    expect(spaceModelRefusal(session, 'github-copilot')).toBeNull();
    expect(spaceModelRefusal({ requestId: null, directory: '/spaces/ffffffffffff/app' }, 'opencode')).toBeNull();
    listed(running({ network: null }));
    expect(spaceModelRefusal(session, 'opencode')).toBeNull();
  });

  test('refuses nothing without an answer: a list not read yet, or a gatekeeper that did not say', () => {
    expect(spaceModelRefusal(session, 'openai')).toBeNull();
    listed(running({ access: 'unknown' }));
    expect(spaceModelRefusal(session, 'openai')).toBeNull();
  });

  test('a provider given later through the dialog is no longer refused by what the creation chose', () => {
    noteSpaceModelAccess({ requestId: 'r1', directory: DIRECTORY }, ['anthropic']);
    listed(running({ state: 'preparing', step: 'creating', grants: [], access: null }));
    expect(spaceModelRefusal({ requestId: 'r1', directory: '/home/me/app' }, 'openai')).toEqual({ spaceId: ID, providerId: 'openai', reason: 'not_granted' });
    listed(running({ grants: [anthropic, { ...anthropic, id: 'openai', provider: 'openai' }] }));
    expect(spaceModelRefusal({ requestId: 'r1', directory: '/home/me/app' }, 'openai')).toBeNull();
  });

  test('while the creation in this window is still giving access, what it chose decides', () => {
    noteSpaceModelAccess({ requestId: 'r1', directory: DIRECTORY }, ['anthropic']);
    listed(running({ grants: [], access: null }));
    useSpacesStore.getState().noteCreationAccess(ID, { kind: 'giving' });
    expect(spaceModelRefusal(session, 'anthropic')).toBeNull();
    expect(spaceModelRefusal(session, 'openai')).toEqual({ spaceId: ID, providerId: 'openai', reason: 'not_granted' });
  });
});
