import { beforeEach, describe, expect, test } from 'bun:test';

import { useConfigStore } from '@/stores/useConfigStore';
import { pendingSpaceSendStep } from './space-send';
import { useUIStore } from '@/stores/useUIStore';
import { resetSpaceModelAccess } from './space-model-offer';
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

const pending = { spaceId: ID, directory: DIRECTORY, draftKey: 'draft-a', model: { providerId: 'opencode-go', modelId: 'm' } };
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

  test('waits for the composer to leave a model the space refuses while the shown one is taken', () => {
    listed(space());
    expect(pendingSpaceSendStep(pending, composer('opencode'))).toBe('wait');
    expect(pendingSpaceSendStep(pending, composer('opencode-go'))).toBe('send');
  });

  test('when access to the shown model is gone, hands it to the send check whatever the composer moved to', () => {
    listed(space({ grants: [] }));
    expect(pendingSpaceSendStep({ ...pending, model: { providerId: 'opencode', modelId: 'big-pickle' } }, composer('opencode-go'))).toBe('send');
  });

  test('gives up when the composer shows another draft, or the start failed', () => {
    listed(space());
    expect(pendingSpaceSendStep(pending, composer('opencode-go', 'm', 'draft-b'))).toBe('drop');
    expect(pendingSpaceSendStep(pending, composer('opencode-go', 'm', null))).toBe('drop');
    useSpacesStore.getState().noteAction(ID, { kind: 'failed', action: 'start', failure: { code: 'gatekeeper_missing', message: '' } });
    expect(pendingSpaceSendStep(pending, composer('opencode-go'))).toBe('drop');
  });
});
