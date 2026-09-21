import { beforeEach, describe, expect, test } from 'bun:test';
import { resolveBtwSelection, useBtwStore } from './useBtwStore';
import { useSelectionStore } from '@/sync/selection-store';

const composerModel = { providerId: 'openai', modelId: 'gpt-5.6-terra' };
const input = {
  agents: [{ name: 'build', mode: 'primary' as const }, { name: 'plan', mode: 'primary' as const }],
  savedAgent: null,
  savedModel: null,
  composerModel,
  composerVariant: 'medium',
};

describe('useBtwStore', () => {
  beforeEach(() => {
    useBtwStore.setState({ byParent: {} });
  });

  test('starts empty', () => {
    expect(useBtwStore.getState().byParent).toEqual({});
  });

  test('setPanelState merges patches per parent', () => {
    useBtwStore.getState().setPanelState('parent-1', { creating: true });
    useBtwStore.getState().setPanelState('parent-1', { collapsed: true });
    expect(useBtwStore.getState().byParent['parent-1']).toEqual({ creating: true, collapsed: true });
  });

  test('parents are independent', () => {
    useBtwStore.getState().setPanelState('parent-1', { collapsed: true });
    useBtwStore.getState().setPanelState('parent-2', { destroying: true });
    expect(useBtwStore.getState().byParent['parent-1']).toEqual({ collapsed: true });
    expect(useBtwStore.getState().byParent['parent-2']).toEqual({ destroying: true });
  });

  test('clearPanelState removes only its parent entry', () => {
    useBtwStore.getState().setPanelState('parent-1', { collapsed: true });
    useBtwStore.getState().setPanelState('parent-2', { collapsed: true });
    useBtwStore.getState().clearPanelState('parent-1');
    expect(useBtwStore.getState().byParent).toEqual({ 'parent-2': { collapsed: true } });
  });

  test('clearPanelState on an unknown parent is a no-op', () => {
    const before = useBtwStore.getState().byParent;
    useBtwStore.getState().clearPanelState('missing');
    expect(useBtwStore.getState().byParent).toBe(before);
  });

  test('inherits model and effort from the main composer, not from the plan agent', () => {
    expect(resolveBtwSelection(input)).toEqual({ agent: 'plan', model: composerModel, variant: 'medium' });
    expect(resolveBtwSelection({ ...input, composerVariant: null }).variant).toBeNull();
    expect(resolveBtwSelection({ ...input, composerModel: null }).model).toBeNull();
    expect(resolveBtwSelection({ ...input, agents: [
      { name: 'hidden', mode: 'primary', hidden: true },
      { name: 'custom', mode: 'primary' },
    ] })).toEqual({ agent: 'custom', model: composerModel, variant: 'medium' });
  });

  test('prefers the saved BTW selection over the current composer', () => {
    const savedModel = { providerId: 'one', modelId: 'selected' };
    expect(resolveBtwSelection({ ...input, savedModel, savedVariant: null }))
      .toEqual({ agent: 'plan', model: savedModel, variant: null });
    expect(resolveBtwSelection({ ...input, savedModel }).variant).toBe(undefined);
  });

  test('publishes BTW effort edits and cancellation without changing the parent', () => {
    const store = useSelectionStore.getState();
    const parent = 'selection-cleanup-parent';
    const pending = `btw-pending:${parent}`;
    for (const session of [parent, pending]) {
      store.saveSessionModelSelection(session, 'one', 'model');
      store.saveSessionAgentSelection(session, 'plan');
      store.saveAgentModelForSession(session, 'plan', 'one', 'model');
      store.saveAgentModelVariantForSession(session, 'plan', 'one', 'model', 'high');
    }
    const observed: Array<string | null | undefined> = [];
    const unsubscribe = useSelectionStore.subscribe((state) => {
      observed.push(state.getAgentModelVariantForSession(pending, 'plan', 'one', 'model'));
    });
    try {
      store.saveAgentModelVariantForSession(pending, 'plan', 'one', 'model', null);
      store.clearSessionSelections(pending);
    } finally {
      unsubscribe();
    }
    expect(observed).toEqual([null, undefined]);
    expect(store.getSessionModelSelection(pending)).toBeNull();
    expect(store.getSessionAgentSelection(pending)).toBeNull();
    expect(store.getAgentModelForSession(pending, 'plan')).toBeNull();
    expect(store.getAgentModelVariantForSession(pending, 'plan', 'one', 'model')).toBe(undefined);
    expect(store.getSessionModelSelection(parent)).toEqual({ providerId: 'one', modelId: 'model' });
    expect(store.getSessionAgentSelection(parent)).toBe('plan');
    expect(store.getAgentModelForSession(parent, 'plan')).toEqual({ providerId: 'one', modelId: 'model' });
    expect(store.getAgentModelVariantForSession(parent, 'plan', 'one', 'model')).toBe('high');
  });
});
