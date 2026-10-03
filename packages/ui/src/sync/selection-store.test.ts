import { beforeEach, expect, test } from 'bun:test';
import { useSelectionStore } from './selection-store';

beforeEach(() => {
  useSelectionStore.setState({
    sessionModelSelections: new Map(),
    sessionAgentSelections: new Map(),
    sessionFollowedAgents: new Map(),
    sessionFollowedModels: new Map(),
    sessionAgentModelSelections: new Map(),
    agentModelVariantSelections: new Map(),
  });
});

test('named effort and explicit Default survive the persisted round trip', () => {
  const store = useSelectionStore.getState();
  store.saveAgentModelVariantForSession('one', 'build', 'provider', 'model', 'high');
  store.saveAgentModelVariantForSession('two', 'build', 'provider', 'model', null);
  const { partialize, merge } = useSelectionStore.persist.getOptions();
  if (!partialize || !merge) throw new Error('Expected persisted selection options');
  const saved = JSON.parse(JSON.stringify(partialize(useSelectionStore.getState())));
  useSelectionStore.setState({ agentModelVariantSelections: new Map() });
  useSelectionStore.setState(merge(saved, useSelectionStore.getState()));
  expect(store.getAgentModelVariantForSession('one', 'build', 'provider', 'model')).toBe('high');
  expect(store.getAgentModelVariantForSession('two', 'build', 'provider', 'model')).toBeNull();
  store.clearSessionSelections('one');
  expect(store.getAgentModelVariantForSession('one', 'build', 'provider', 'model')).toBeUndefined();
  expect(store.getAgentModelVariantForSession('two', 'build', 'provider', 'model')).toBeNull();
  store.saveAgentModelVariantForSession('two', 'build', 'provider', 'model', undefined);
  expect(useSelectionStore.getState().agentModelVariantSelections.size).toBe(0);
});

test('old or malformed variant data cannot erase current choices', () => {
  const store = useSelectionStore.getState();
  store.saveAgentModelVariantForSession('one', 'build', 'provider', 'model', 'high');
  const { merge } = useSelectionStore.persist.getOptions();
  if (!merge) throw new Error('Expected persisted selection merge');
  for (const saved of [{}, { agentModelVariantSelections: [['one', 42]] }]) {
    useSelectionStore.setState(merge(saved, useSelectionStore.getState()));
    expect(store.getAgentModelVariantForSession('one', 'build', 'provider', 'model')).toBe('high');
  }
});

test('a session agent switch is followed once, and a later pick survives an unchanged record', () => {
  const store = useSelectionStore.getState();
  // First sight of the record: the composer takes the session's agent.
  expect(store.followSessionAgent('one', 'plan')).toBe(true);
  expect(store.getSessionAgentSelection('one')).toBe('plan');
  // The user picks Build without sending; the record still says Plan.
  store.saveSessionAgentSelection('one', 'build');
  expect(store.followSessionAgent('one', 'plan')).toBe(false);
  expect(store.getSessionAgentSelection('one')).toBe('build');
  // A plugin or another client switches the session: the newer switch wins.
  store.saveSessionAgentSelection('one', 'plan');
  expect(store.followSessionAgent('one', 'review')).toBe(true);
  expect(store.getSessionAgentSelection('one')).toBe('review');
  expect(store.getSessionAgentSelection('two')).toBeNull();
});

test('the followed agent survives the persisted round trip and goes with the session', () => {
  const store = useSelectionStore.getState();
  store.followSessionAgent('one', 'plan');
  store.saveSessionAgentSelection('one', 'build');
  const { partialize, merge } = useSelectionStore.persist.getOptions();
  if (!partialize || !merge) throw new Error('Expected persisted selection options');
  const saved = JSON.parse(JSON.stringify(partialize(useSelectionStore.getState())));
  useSelectionStore.setState({ sessionFollowedAgents: new Map(), sessionAgentSelections: new Map() });
  useSelectionStore.setState(merge(saved, useSelectionStore.getState()));
  // After a reload the unsent pick is still newer than the unchanged record.
  expect(store.followSessionAgent('one', 'plan')).toBe(false);
  expect(store.getSessionAgentSelection('one')).toBe('build');
  // Payloads written before this field existed keep what memory holds.
  useSelectionStore.setState(merge({ sessionAgentSelections: [['one', 'build']] }, useSelectionStore.getState()));
  expect(useSelectionStore.getState().sessionFollowedAgents.get('one')).toBe('plan');
  store.clearSessionSelections('one');
  expect(useSelectionStore.getState().sessionFollowedAgents.has('one')).toBe(false);
  expect(store.followSessionAgent('one', 'plan')).toBe(true);
});

test('a session model switch counts only against a model already reconciled', () => {
  const store = useSelectionStore.getState();
  // Nothing reconciled yet: no evidence of a switch, a disagreeing pick stays.
  expect(store.isSessionModelSwitched('one', 'p/a#')).toBe(false);
  store.markSessionModelFollowed('one', 'p/a#');
  expect(store.isSessionModelSwitched('one', 'p/a#')).toBe(false);
  expect(store.isSessionModelSwitched('one', 'p/b#')).toBe(true);
  expect(store.isSessionModelSwitched('one', 'p/a#high')).toBe(true);
  const { partialize, merge } = useSelectionStore.persist.getOptions();
  if (!partialize || !merge) throw new Error('Expected persisted selection options');
  const saved = JSON.parse(JSON.stringify(partialize(useSelectionStore.getState())));
  useSelectionStore.setState({ sessionFollowedModels: new Map() });
  useSelectionStore.setState(merge(saved, useSelectionStore.getState()));
  expect(store.isSessionModelSwitched('one', 'p/b#')).toBe(true);
  store.clearSessionSelections('one');
  expect(store.isSessionModelSwitched('one', 'p/b#')).toBe(false);
});
