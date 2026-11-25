import { beforeEach, describe, expect, test } from 'bun:test';

import { composerModelForSpace } from './composer-space-model';
import { spaceModelRefusal, stoppedSpaceOfTarget } from './space-model-access';
import { activeSpaceTarget, composerModelForSpaceAccess, noteSpaceModelAccess, resetSpaceModelAccess, spaceModelOffer, spaceOfferAllows } from './space-model-offer';
import { createPendingDraftWorktreeRequest, resolvePendingDraftWorktreeRequest } from '@/lib/worktrees/pendingDraftWorktree';
import { parallelRunPlaceOf } from './parallel-run-place';
import { noteSpaceCreationRequest, resetSpaceCreationRequests } from './space-creation-requests';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSelectionStore } from '@/sync/selection-store';
import type { Session } from '@/lib/opencode/model';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';
import type { SpaceEntry } from './spaces-api';
import { useSpacesStore } from './spaces-store';

const ID = 'a1b2c3d4e5f6';
const DIRECTORY = `/spaces/${ID}/app`;
const anthropic = { kind: 'model' as const, id: 'anthropic', provider: 'anthropic', upstream: 'https://api.anthropic.com/v1', source: { kind: 'typed' as const }, url: 'http://gatekeeper:8080/model/anthropic' };

const running = (change: Partial<SpaceEntry> = {}): SpaceEntry => ({
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
  grants: [anthropic],
  access: 'granted',
  needsAccess: [],
  accessFailures: [],
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

  test('a provider of the user\'s own counts once the host lists it for the space\'s project, and not before', () => {
    listed(running());
    // The host has not been asked about this project yet: nothing is refused on a guess.
    expect(spaceModelRefusal(session, 'ollama-local')).toBeNull();
    useSpacesStore.getState().noteCustomProviders('/home/me/app', [{ id: 'ollama-local', name: 'Ollama (local)', package: 'aisdk:@ai-sdk/openai-compatible', baseURL: 'http://localhost:11434/v1', loopback: true, models: ['qwen3:8b'], hasKey: false, supported: true }]);
    expect(spaceModelRefusal(session, 'ollama-local')).toEqual({ spaceId: ID, providerId: 'ollama-local', reason: 'not_granted' });
    const custom = { kind: 'custom' as const, id: 'ollama-local', provider: 'ollama-local', url: 'http://gatekeeper:8080/model/ollama-local' };
    listed(running({ grants: [anthropic, custom] }));
    expect(spaceModelRefusal(session, 'ollama-local')).toBeNull();
    listed(running({ grants: [anthropic, custom], access: 'needs_access', needsAccess: ['ollama-local'] }));
    expect(spaceModelRefusal(session, 'ollama-local')).toEqual({ spaceId: ID, providerId: 'ollama-local', reason: 'needs_again' });
  });

  test('a provider of the host\'s catalog counts once the host lists it as one a key can be given for', () => {
    listed(running());
    expect(spaceModelRefusal(session, 'opencode-go')).toBeNull();
    useSpacesStore.getState().noteCatalogProviders('/home/me/app', [{ id: 'opencode-go', name: 'OpenCode Go', supported: true, storedKey: true }, { id: 'amazon-bedrock', name: 'Bedrock', supported: false, storedKey: false }]);
    expect(spaceModelRefusal(session, 'opencode-go')).toEqual({ spaceId: ID, providerId: 'opencode-go', reason: 'not_granted' });
    // One no grant can give would send the user to a dialog that cannot help.
    expect(spaceModelRefusal(session, 'amazon-bedrock')).toBeNull();
  });

  test('a key the gatekeeper lost after a restart needs the user again', () => {
    listed(running({ access: 'needs_access', needsAccess: ['anthropic'] }));
    expect(spaceModelRefusal(session, 'anthropic')).toEqual({ spaceId: ID, providerId: 'anthropic', reason: 'needs_again' });
  });

  test('the host\'s login given to the space is access, and access to give again once the host cannot say it', () => {
    const login = { kind: 'login' as const, id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing', url: 'http://gatekeeper:8080/model/openai' };
    listed(running({ grants: [login] }));
    expect(spaceModelRefusal(session, 'openai')).toBeNull();
    listed(running({ grants: [login], access: 'needs_access', needsAccess: ['openai'] }));
    expect(spaceModelRefusal(session, 'openai')).toEqual({ spaceId: ID, providerId: 'openai', reason: 'needs_again' });
  });

  test('GitHub Copilot is given only through the host\'s login: refused without one, access with it', () => {
    listed(running({ grants: [], access: null }));
    expect(spaceModelRefusal(session, 'github-copilot')).toEqual({ spaceId: ID, providerId: 'github-copilot', reason: 'not_granted' });
    listed(running({ grants: [{ kind: 'login' as const, id: 'github-copilot', provider: 'github-copilot', method: 'device', url: 'http://gatekeeper:8080/model/github-copilot' }] }));
    expect(spaceModelRefusal(session, 'github-copilot')).toBeNull();
  });

  test('a space with no grant at all refuses every provider, as after a reload during its creation', () => {
    listed(running({ grants: [], access: null }));
    expect(spaceModelRefusal(session, 'anthropic')).toEqual({ spaceId: ID, providerId: 'anthropic', reason: 'not_granted' });
  });

  test('never refuses a provider the grant dialog cannot give a key for, other than OpenCode\'s own', () => {
    listed(running({ grants: [], access: null, network: { mode: 'open', domains: [] } }));
    expect(spaceModelRefusal(session, 'azure')).toBeNull();
  });

  test("refuses OpenCode's own provider in every space, whatever the network, while it is made and once it runs", () => {
    const refused = { spaceId: ID, providerId: 'opencode', reason: 'opencode' };
    noteSpaceModelAccess({ requestId: 'r1', directory: DIRECTORY }, ['anthropic']);
    listed(running({ state: 'preparing', step: 'creating', grants: [], access: null }));
    expect(spaceModelRefusal({ requestId: 'r1', directory: '/home/me/app' }, 'opencode')).toEqual(refused);
    for (const network of [{ mode: 'open' as const, domains: [] }, { mode: 'allowlist' as const, domains: ['opencode.ai'] }, { mode: 'allowlist' as const, domains: [] }, null]) {
      listed(running({ network }));
      expect(spaceModelRefusal(session, 'opencode')).toEqual(refused);
    }
    // A space not listed yet refuses it too: no grant can give a space OpenCode's free models.
    expect(spaceModelRefusal({ requestId: null, directory: '/spaces/ffffffffffff/app' }, 'opencode')).toEqual({ ...refused, spaceId: 'ffffffffffff' });
    // The host's own chats are not a space's business.
    expect(spaceModelRefusal({ requestId: null, directory: '/home/me/app' }, 'opencode')).toBeNull();
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

  test('a stopped space is named before any model is looked at; a running or unlisted one is not', () => {
    expect(stoppedSpaceOfTarget(session)).toBeNull();
    listed(running({ state: 'exited', stoppedIdle: true }));
    expect(stoppedSpaceOfTarget(session)).toEqual({ spaceId: ID, reason: 'stopped', start: true });
    // A draft still waiting on its creation request names the space by that request.
    noteSpaceModelAccess({ requestId: 'r1', directory: DIRECTORY }, ['anthropic']);
    expect(stoppedSpaceOfTarget({ requestId: 'r1', directory: '/home/me/app' })).toEqual({ spaceId: ID, reason: 'stopped', start: true });
    expect(stoppedSpaceOfTarget({ requestId: null, directory: '/home/me/app' })).toBeNull();
    // A stopped space whose gatekeeper is gone never starts again; a space whose container is gone can only be deleted.
    listed(running({ state: 'exited', damage: 'gatekeeper_gone' }));
    expect(stoppedSpaceOfTarget(session)).toEqual({ spaceId: ID, reason: 'stopped', start: false });
    // A space whose machine is off takes nothing either, and no start brings it back from here.
    listed(running({ state: 'unreachable', failure: { code: 'place_unreachable', message: '' } }));
    expect(stoppedSpaceOfTarget(session)).toEqual({ spaceId: ID, reason: 'unreachable', start: false });
    listed(running({ state: 'missing' }));
    expect(stoppedSpaceOfTarget(session)).toEqual({ spaceId: ID, reason: 'gone', start: false });
    listed(running());
    expect(stoppedSpaceOfTarget(session)).toBeNull();
  });

  test('while the space is still being made, what the creation in this window chose decides', () => {
    noteSpaceModelAccess({ requestId: 'r1', directory: DIRECTORY }, ['anthropic']);
    listed(running({ state: 'preparing', step: 'giving_access', grants: [], access: null }));
    expect(spaceModelRefusal(session, 'anthropic')).toBeNull();
    expect(spaceModelRefusal(session, 'openai')).toEqual({ spaceId: ID, providerId: 'openai', reason: 'not_granted' });
  });
});

describe('what a space\'s model picker offers', () => {
  beforeEach(() => {
    useSpacesStore.getState().resetForRuntimeSwitch();
    resetSpaceModelAccess();
  });
  const offer = () => spaceModelOffer(session);
  const allowed = (...ids: string[]) => ids.filter((id) => spaceOfferAllows(offer(), id));

  test('nothing is filtered outside a space', () => {
    const host = spaceModelOffer({ requestId: null, directory: '/home/me/app' });
    expect(host).toBeNull();
    expect(spaceOfferAllows(host, 'opencode')).toBe(true);
    expect(spaceModelOffer(null)).toBeNull();
  });

  test('a running space offers keys, logins and custom providers it holds, and no other provider or Auto', () => {
    listed(running({ grants: [
      anthropic,
      { kind: 'login', id: 'openai', provider: 'openai', method: 'chatgpt-token-sharing', url: 'http://gatekeeper:8080/model/openai' },
      { kind: 'custom', id: 'ollama', provider: 'ollama', url: 'http://gatekeeper:8080/model/ollama' },
    ] }));
    expect(allowed('anthropic', 'openai', 'ollama', 'azure', 'groq', 'opencode', 'openchamber')).toEqual(['anthropic', 'openai', 'ollama']);
    expect(offer()?.give).toBe('now');
  });

  test('a provider whose key is needed again is off the list and named for the grant row', () => {
    listed(running({ access: 'needs_access', needsAccess: ['anthropic'] }));
    expect(allowed('anthropic')).toEqual([]);
    expect(offer()?.needsAgain).toEqual(['anthropic']);
  });

  test('a grant given later is offered at once', () => {
    listed(running({ grants: [] }));
    expect(offer()?.held).toEqual([]);
    useSpacesStore.getState().noteGrantGiven(ID, anthropic);
    expect(allowed('anthropic')).toEqual(['anthropic']);
  });

  test('an unknown grant state keeps every provider but OpenCode\'s own', () => {
    expect(allowed('openai', 'opencode')).toEqual(['openai']);
    expect(offer()?.give).toBeNull();
    for (const change of [{ access: 'unknown' as const }, { network: null, grants: [] }, { state: 'unreachable' as const }, { state: 'missing' as const }]) {
      listed(running(change));
      expect(offer()?.held).toBeNull();
      expect(allowed('openai', 'opencode')).toEqual(['openai']);
    }
  });

  test('a stopped space offers what a start brings back, so a pasted key is needed again, and asks for that start', () => {
    const env = { ...anthropic, id: 'openai', provider: 'openai', source: { kind: 'env' as const, name: 'OPENAI_API_KEY' } };
    listed(running({ state: 'exited', access: null, grants: [anthropic, env] }));
    expect(offer()).toEqual({ spaceId: ID, held: ['openai'], needsAgain: ['anthropic'], give: 'after_start' });
    listed(running({ state: 'exited', access: null, damage: 'gatekeeper_gone' }));
    expect(offer()?.give).toBeNull();
  });

  test('the send check agrees on Auto and on an unreadable record', () => {
    listed(running({ grants: [] }));
    expect(spaceModelRefusal(session, 'openchamber')).toEqual({ spaceId: ID, providerId: 'openchamber', reason: 'not_granted' });
    listed(running({ grants: [], network: null }));
    expect(spaceModelRefusal(session, 'openchamber')).toBeNull();
    expect(spaceModelRefusal(session, 'openai')).toBeNull();
  });

  test('a parallel run goes to the draft\'s space, waits for one being made, and stays on the host only for a host draft', () => {
    expect(parallelRunPlaceOf({ requestId: null, directory: '/home/me/app' })).toEqual({ kind: 'host' });
    listed(running());
    expect(parallelRunPlaceOf(session)).toEqual({ kind: 'space', directory: DIRECTORY });
    const waiting = createPendingDraftWorktreeRequest();
    noteSpaceCreationRequest(waiting, ID);
    noteSpaceModelAccess({ requestId: waiting, directory: DIRECTORY }, ['anthropic']);
    // Running while the setup commands the user asked to wait for still go.
    expect(parallelRunPlaceOf({ requestId: waiting, directory: '/home/me/app' })).toEqual({ kind: 'preparing' });
    resolvePendingDraftWorktreeRequest(waiting, DIRECTORY, { keep: true });
    expect(parallelRunPlaceOf({ requestId: waiting, directory: '/home/me/app' })).toEqual({ kind: 'space', directory: DIRECTORY });
    noteSpaceCreationRequest('r2', ID);
    expect(parallelRunPlaceOf({ requestId: 'r2', directory: '/home/me/app' })).toEqual({ kind: 'preparing' });
    noteSpaceModelAccess({ requestId: 'r2', directory: DIRECTORY }, ['anthropic']);
    listed(running({ state: 'preparing', step: 'creating' }));
    expect(parallelRunPlaceOf({ requestId: 'r2', directory: '/home/me/app' })).toEqual({ kind: 'preparing' });
    listed(running());
    expect(parallelRunPlaceOf({ requestId: 'r2', directory: '/home/me/app' })).toEqual({ kind: 'space', directory: DIRECTORY });
    resetSpaceCreationRequests();
  });

  test('the target on screen is the draft\'s or the session\'s, and changes with it', () => {
    useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: DIRECTORY, preserveDirectoryOverride: true });
    expect(activeSpaceTarget()).toEqual({ requestId: null, directory: DIRECTORY });
    useSessionUIStore.setState((state) => ({ newSessionDraft: { ...state.newSessionDraft, directoryOverride: '/home/me/app' } }));
    expect(activeSpaceTarget().directory).toBe('/home/me/app');
  });

  test('a space being made offers what was chosen for it, until the list brings the real grants', () => {
    noteSpaceModelAccess({ requestId: 'r1', directory: DIRECTORY }, ['openai']);
    listed(running({ state: 'preparing', step: 'creating', grants: [], access: null }));
    const draft = () => spaceModelOffer({ requestId: 'r1', directory: '/home/me/app' });
    expect(draft()).toEqual({ spaceId: ID, held: ['openai'], needsAgain: [], give: null });
    listed(running({ grants: [], access: null }));
    expect(draft()?.held).toEqual(['openai']);
    listed(running({ grants: [], access: null, accessFailures: [{ provider: 'openai', code: 'login_expired', message: '' }] }));
    expect(draft()?.held).toEqual([]);
  });
});

describe('the composer model for a new space', () => {
  // A provider as the config store keeps it, in the shape its own tests use.
  const model = (providerID: string, modelID: string) => ({
    id: `${providerID}/${modelID}`, modelID, providerID, name: modelID,
    capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }], status: 'active' as const, enabled: true, limit: { context: 0, output: 0 },
  });
  const catalog = (providers: Array<{ id: string; models: string[] }>) => {
    useConfigStore.setState({ providers: providers.map((provider) => ({ id: provider.id, name: provider.id, activation: 'enabled' as const, package: provider.id, models: provider.models.map((modelID) => model(provider.id, modelID)) })) });
  };

  test('moves off a provider the space was not given, to the model last used of one it was', () => {
    catalog([{ id: 'opencode', models: ['big-pickle'] }, { id: 'openai', models: ['gpt-a', 'gpt-b'] }]);
    useConfigStore.setState({ currentProviderId: 'opencode' });
    useUIStore.setState({ recentModels: [{ providerID: 'openai', modelID: 'gpt-b' }], hiddenModels: [] });
    expect(composerModelForSpaceAccess(['openai'])).toEqual({ providerId: 'openai', modelId: 'gpt-b' });

    useUIStore.setState({ recentModels: [], hiddenModels: [{ providerID: 'openai', modelID: 'gpt-a' }] });
    expect(composerModelForSpaceAccess(['openai'])).toEqual({ providerId: 'openai', modelId: 'gpt-b' });
  });

  test('stays when the composer is on a given provider, or none is known', () => {
    catalog([{ id: 'openai', models: ['gpt-a'] }]);
    useConfigStore.setState({ currentProviderId: 'openai' });
    expect(composerModelForSpaceAccess(['openai'])).toBeNull();
    useConfigStore.setState({ currentProviderId: 'opencode' });
    expect(composerModelForSpaceAccess(['anthropic'])).toBeNull();
    expect(composerModelForSpaceAccess([])).toBeNull();
  });

  test('a draft that starts targeting a running space leaves a model the space would refuse, for one of a provider it holds', () => {
    useSpacesStore.getState().resetForRuntimeSwitch();
    catalog([{ id: 'opencode', models: ['big-pickle'] }, { id: 'opencode-go', models: ['deepseek-v4.1-flash'] }]);
    useUIStore.setState({ recentModels: [], hiddenModels: [] });
    const go = { kind: 'model' as const, id: 'opencode-go', provider: 'opencode-go', upstream: 'https://opencode.ai/inference/go/', source: { kind: 'stored' as const, integration: 'opencode' }, url: 'http://gatekeeper:8080/model/opencode-go' };
    listed(running({ grants: [go] }));
    useSpacesStore.getState().noteCatalogProviders('/home/me/app', [{ id: 'opencode-go', name: 'OpenCode Go', supported: true, storedKey: true }]);
    useConfigStore.setState({ currentProviderId: 'opencode' });
    expect(composerModelForSpace(spaceModelOffer(session), null)).toEqual({ providerId: 'opencode-go', modelId: 'deepseek-v4.1-flash' });
    // A model the space takes stays.
    useConfigStore.setState({ currentProviderId: 'opencode-go' });
    expect(composerModelForSpace(spaceModelOffer(session), null)).toBeNull();
    useConfigStore.setState({ currentProviderId: 'opencode' });
    // A stopped space shows a model it may use as well, from its record.
    listed(running({ grants: [go], state: 'exited', access: null }));
    expect(composerModelForSpace(spaceModelOffer(session), null)).toEqual({ providerId: 'opencode-go', modelId: 'deepseek-v4.1-flash' });
    // Nothing is moved on a guess: no list, a silent gatekeeper, an unreadable record, a machine that does not answer, or no grant to move to.
    for (const change of [{ access: 'unknown' as const }, { network: null }, { state: 'unreachable' as const }, { grants: [] }]) {
      listed(running({ grants: [go], ...change }));
      expect(composerModelForSpace(spaceModelOffer(session), null)).toBeNull();
    }
    useSpacesStore.getState().resetForRuntimeSwitch();
    expect(composerModelForSpace(spaceModelOffer(session), null)).toBeNull();
  });

  test('a stopped session shows its own model when the space takes it, and the user\'s pick before that', () => {
    useSpacesStore.getState().resetForRuntimeSwitch();
    catalog([{ id: 'openai', models: ['gpt-a', 'gpt-b'] }, { id: 'anthropic', models: ['claude'] }]);
    useUIStore.setState({ recentModels: [], hiddenModels: [] });
    const kept = { ...anthropic, source: { kind: 'env' as const, name: 'KEY' } };
    listed(running({ grants: [kept, { ...kept, id: 'openai', provider: 'openai' }], state: 'exited', access: null }));
    useConfigStore.setState({ currentProviderId: 'anthropic', currentModelId: 'claude' });
    const record: Session = {
      id: 'ses_1', projectID: 'p', directory: DIRECTORY, title: 'Login bug', cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 0, updated: 0 },
      model: { providerID: 'openai', id: 'gpt-b' },
    };
    useGlobalSessionsStore.setState({ activeSessions: [record] });
    const own = () => composerModelForSpace(spaceModelOffer(session), 'ses_1');
    expect(own()).toEqual({ providerId: 'openai', modelId: 'gpt-b' });
    useSelectionStore.getState().pickSessionModel('ses_1', 'openai', 'gpt-a');
    expect(own()).toEqual({ providerId: 'openai', modelId: 'gpt-a' });
    useSelectionStore.getState().clearSessionSelections('ses_1');
    listed(running({ grants: [kept], state: 'exited', access: null }));
    expect(own()).toBeNull();
  });
});
