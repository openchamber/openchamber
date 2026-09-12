import { beforeEach, describe, expect, test } from 'bun:test';

import { useSelectionStore } from './selection-store';

const SESSION_A = 'session-a';
const SESSION_B = 'session-b';

const resetSelections = () => {
  useSelectionStore.setState({
    sessionModelSelections: new Map(),
    sessionAgentSelections: new Map(),
    sessionAgentModelSelections: new Map(),
    lastUsedProvider: null,
  });
};

describe('clearSessionAgentSelection', () => {
  beforeEach(resetSelections);

  test('clears the session agent choice and the model recorded for that agent', () => {
    const store = useSelectionStore.getState();
    store.saveSessionAgentSelection(SESSION_A, 'build');
    store.saveAgentModelForSession(SESSION_A, 'build', 'provider-a', 'model-a');
    store.saveAgentModelForSession(SESSION_A, 'plan', 'provider-a', 'model-b');
    store.saveSessionAgentSelection(SESSION_B, 'build');
    store.saveAgentModelForSession(SESSION_B, 'build', 'provider-a', 'model-a');

    useSelectionStore.getState().clearSessionAgentSelection(SESSION_A, 'build');

    const after = useSelectionStore.getState();
    expect(after.getSessionAgentSelection(SESSION_A)).toBeNull();
    expect(after.getAgentModelForSession(SESSION_A, 'build')).toBeNull();
    // Other agents of the same session and other sessions stay untouched.
    expect(after.getAgentModelForSession(SESSION_A, 'plan')).toEqual({
      providerId: 'provider-a',
      modelId: 'model-b',
    });
    expect(after.getSessionAgentSelection(SESSION_B)).toBe('build');
    expect(after.getAgentModelForSession(SESSION_B, 'build')).toEqual({
      providerId: 'provider-a',
      modelId: 'model-a',
    });
  });

  test('without an agent name nothing is cleared, because no dropped name can match', () => {
    const store = useSelectionStore.getState();
    store.saveSessionAgentSelection(SESSION_A, 'build');
    store.saveAgentModelForSession(SESSION_A, 'build', 'provider-a', 'model-a');

    useSelectionStore.getState().clearSessionAgentSelection(SESSION_A);

    const after = useSelectionStore.getState();
    expect(after.getSessionAgentSelection(SESSION_A)).toBe('build');
    expect(after.getAgentModelForSession(SESSION_A, 'build')).toEqual({
      providerId: 'provider-a',
      modelId: 'model-a',
    });
  });

  test('keeps a different stored choice when the dropped name does not match', () => {
    const store = useSelectionStore.getState();
    store.saveSessionAgentSelection(SESSION_A, 'orchestrator');
    store.saveAgentModelForSession(SESSION_A, 'orchestrator', 'provider-a', 'model-a');

    // The send carried an explicit or ambient name this directory dropped; the
    // session's own valid preference must survive.
    useSelectionStore.getState().clearSessionAgentSelection(SESSION_A, 'ghost');

    const after = useSelectionStore.getState();
    expect(after.getSessionAgentSelection(SESSION_A)).toBe('orchestrator');
    expect(after.getAgentModelForSession(SESSION_A, 'orchestrator')).toEqual({
      providerId: 'provider-a',
      modelId: 'model-a',
    });
  });

  test('is a no-op for a session with nothing recorded', () => {
    const before = useSelectionStore.getState();
    useSelectionStore.getState().clearSessionAgentSelection(SESSION_A, 'build');
    const after = useSelectionStore.getState();

    expect(after.sessionAgentSelections).toBe(before.sessionAgentSelections);
    expect(after.sessionAgentModelSelections).toBe(before.sessionAgentModelSelections);
  });
});
