import { beforeEach, describe, expect, test } from 'bun:test';

import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { followPendingSpaceModel, pendingSpaceSendStep } from './space-send';
import { useUIStore } from '@/stores/useUIStore';
import { resetSpaceModelAccess } from './space-model-access';
import type { Session } from '@/lib/opencode/model';
import type { SpaceEntry } from './spaces-api';
import { useSpacesStore } from './spaces-store';

const ID = 'a1b2c3d4e5f6';
const DIRECTORY = `/spaces/${ID}/app`;
const go = { kind: 'model' as const, id: 'opencode-go', provider: 'opencode-go', upstream: 'https://opencode.ai/inference/go/', source: { kind: 'stored' as const, integration: 'opencode' }, url: 'http://gatekeeper:8080/model/opencode-go' };

const space = (change: Partial<SpaceEntry> = {}): SpaceEntry => ({
  id: ID,
  name: 'Fix login',
  placeId: 'docker', machine: null,
  projectDirectory: '/home/me/app',
  projectFolder: { path: '/home/me/app', found: true },
  directory: DIRECTORY,
  state: 'running',
  stoppedIdle: false,
  step: null,
  failure: null,
  network: { mode: 'allowlist', domains: [] },
  grants: [go],
  access: 'granted',
  needsAccess: [],
  accessFailures: [],
  damage: null,
  setup: null,
  ...change,
});

const listed = (entry: SpaceEntry) => useSpacesStore.getState().applyJourney([entry], useSpacesStore.getState().progressRevision);

const model = (providerID: string, modelID: string) => ({
  id: `${providerID}/${modelID}`, modelID, providerID, name: modelID,
  capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 },
  cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], status: 'active' as const, enabled: true, limit: { context: 0, output: 0 },
});

const pending = { spaceId: ID, directory: DIRECTORY, sessionId: null, draftKey: 'draft-a' };
const composer = (providerId: string, modelId = 'm', draftKey: string | null = 'draft-a') => ({ draftKey, providerId, modelId });

describe('"Start and send" waits for the composer it was pressed in to be ready', () => {
  beforeEach(() => {
    useSpacesStore.getState().resetForRuntimeSwitch();
    resetSpaceModelAccess();
    useConfigStore.setState({
      currentProviderId: 'opencode',
      providers: [
        { id: 'opencode', name: 'opencode', activation: 'enabled' as const, package: 'opencode', models: [model('opencode', 'big-pickle')] },
        { id: 'opencode-go', name: 'opencode-go', activation: 'enabled' as const, package: 'opencode-go', models: [model('opencode-go', 'deepseek-v4.1-flash')] },
      ],
    });
    useUIStore.setState({ recentModels: [], hiddenModels: [] });
  });

  test('waits while the space starts and while the space\'s models are still loading', () => {
    listed(space({ state: 'exited' }));
    expect(pendingSpaceSendStep(pending, composer('opencode-go'))).toBe('wait');
    listed(space());
    // Listed running while the start still reads the session list: the session's model is not known yet.
    useSpacesStore.getState().noteAction(ID, { kind: 'running', action: 'start' });
    expect(pendingSpaceSendStep(pending, composer('opencode'))).toBe('wait');
    useSpacesStore.getState().noteAction(ID, null);
    expect(pendingSpaceSendStep(pending, composer('', ''))).toBe('wait');
    expect(pendingSpaceSendStep(pending, composer('opencode-go'))).toBe('send');
  });

  test('first moves off a model the space refuses when it holds another, and sends a refused one it cannot replace', () => {
    listed(space());
    expect(pendingSpaceSendStep(pending, composer('opencode'))).toBe('follow');
    listed(space({ grants: [] }));
    expect(pendingSpaceSendStep(pending, composer('opencode'))).toBe('send');
  });

  test('a session moves back to its own model when the space takes it, before any other granted one', () => {
    listed(space());
    useUIStore.setState({ recentModels: [{ providerID: 'opencode-go', modelID: 'hy4-flash-free' }], hiddenModels: [] });
    const session: Session = {
      id: 'ses_1', projectID: 'p', directory: DIRECTORY, title: 'Login bug', cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 0, updated: 0 },
      model: { providerID: 'opencode-go', id: 'deepseek-v4.1-flash' },
    };
    useGlobalSessionsStore.setState({ activeSessions: [session] });
    const forSession = { ...pending, sessionId: 'ses_1' };
    expect(pendingSpaceSendStep(forSession, composer('opencode'))).toBe('follow');
    followPendingSpaceModel(forSession);
    expect([useConfigStore.getState().currentProviderId, useConfigStore.getState().currentModelId]).toEqual(['opencode-go', 'deepseek-v4.1-flash']);
    // A remembered model the space's catalog no longer lists gives way to a granted one it does.
    useGlobalSessionsStore.setState({ activeSessions: [{ ...session, model: { providerID: 'opencode-go', id: 'gone-model' } }] });
    useConfigStore.setState({ currentProviderId: 'opencode', currentModelId: 'big-pickle' });
    followPendingSpaceModel(forSession);
    expect(useConfigStore.getState().currentModelId).toBe('deepseek-v4.1-flash');
  });

  test('a composer whose model is not the shared selection sends as it is', () => {
    listed(space());
    useConfigStore.setState({ currentProviderId: 'opencode-go' });
    expect(pendingSpaceSendStep(pending, composer('opencode'))).toBe('send');
  });

  test('gives up when the composer shows another draft, or the start failed', () => {
    listed(space());
    expect(pendingSpaceSendStep(pending, composer('opencode-go', 'm', 'draft-b'))).toBe('drop');
    expect(pendingSpaceSendStep(pending, composer('opencode-go', 'm', null))).toBe('drop');
    useSpacesStore.getState().noteAction(ID, { kind: 'failed', action: 'start', failure: { code: 'gatekeeper_missing', message: '' } });
    expect(pendingSpaceSendStep(pending, composer('opencode-go'))).toBe('drop');
  });
});
