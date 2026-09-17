import { beforeEach, expect, test } from 'bun:test';
import { useSelectionStore } from './selection-store';

beforeEach(() => {
  useSelectionStore.setState({
    sessionModelSelections: new Map(),
    sessionAgentSelections: new Map(),
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
