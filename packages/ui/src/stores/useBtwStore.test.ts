import { beforeEach, describe, expect, test } from 'bun:test';
import { btwModelAvailability, resolveBtwSelection, useBtwStore } from './useBtwStore';
import { useSelectionStore } from '@/sync/selection-store';

const composerModel = { providerId: 'openai', modelId: 'gpt-5.6-terra' };
const input = {
  agents: [{ name: 'build', mode: 'primary' as const, hidden: false }, { name: 'plan', mode: 'primary' as const, hidden: false }],
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
      { name: 'hidden', mode: 'primary' as const, hidden: true },
      { name: 'custom', mode: 'primary' as const, hidden: false },
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

const AGENTS = [
  { name: 'build', hidden: false, mode: 'primary' as const },
  { name: 'plan', hidden: false, mode: 'primary' as const },
];
const COMPOSER = { providerId: 'omniroute', modelId: 'orchestrator' };
const SAVED_DEAD = { providerId: 'opencode-omniroute-live', modelId: 'orchestrator' };

describe('resolveBtwSelection with a live-catalog check', () => {
  test('falls back to the composer model when the saved model is not in the live catalog', () => {
    const selection = resolveBtwSelection({
      agents: AGENTS,
      savedAgent: 'plan',
      savedModel: SAVED_DEAD,
      savedVariant: 'high',
      composerModel: COMPOSER,
      composerVariant: 'high',
      isModelAvailable: (model) => model.providerId === 'omniroute',
    });
    expect(selection.model).toEqual(COMPOSER);
    expect(selection.variant).toBe('high');
  });

  test('keeps a saved model the live catalog still offers', () => {
    const selection = resolveBtwSelection({
      agents: AGENTS,
      savedAgent: 'plan',
      savedModel: COMPOSER,
      savedVariant: 'high',
      composerModel: COMPOSER,
      composerVariant: 'low',
      isModelAvailable: () => true,
    });
    expect(selection.model).toEqual(COMPOSER);
    expect(selection.variant).toBe('high');
  });

  test('keeps the saved model when no availability check is provided', () => {
    const selection = resolveBtwSelection({
      agents: AGENTS,
      savedAgent: 'plan',
      savedModel: SAVED_DEAD,
      savedVariant: 'high',
      composerModel: COMPOSER,
      composerVariant: 'high',
    });
    expect(selection.model).toEqual(SAVED_DEAD);
    expect(selection.variant).toBe('high');
  });

  test('a dead saved model keeps the saved agent and takes the composer variant', () => {
    const selection = resolveBtwSelection({
      agents: AGENTS,
      savedAgent: 'plan',
      savedModel: SAVED_DEAD,
      savedVariant: 'high',
      composerModel: COMPOSER,
      composerVariant: null,
      isModelAvailable: () => false,
    });
    expect(selection.agent).toBe('plan');
    expect(selection.model).toEqual(COMPOSER);
    expect(selection.variant).toBe(null);
  });
});

describe('btwModelAvailability', () => {
  const catalog = [{ id: 'omniroute', models: [{ id: 'orchestrator', modelID: 'orchestrator' }] }];
  const AUTO = { providerId: 'openchamber', modelId: 'auto' };

  test('offers no check while the catalog is empty, so the saved model wins', () => {
    expect(btwModelAvailability([], true)).toBeUndefined();
  });

  test('accepts catalog models and rejects models the catalog no longer has', () => {
    const isAvailable = btwModelAvailability(catalog, false);
    expect(isAvailable?.(COMPOSER)).toBe(true);
    expect(isAvailable?.(SAVED_DEAD)).toBe(false);
  });

  test('keeps a saved Auto while routing is ready, though Auto is never in the catalog', () => {
    const selection = resolveBtwSelection({
      agents: AGENTS,
      savedAgent: 'plan',
      savedModel: AUTO,
      savedVariant: null,
      composerModel: COMPOSER,
      composerVariant: 'high',
      isModelAvailable: btwModelAvailability(catalog, true),
    });
    expect(selection.model).toEqual(AUTO);
    expect(selection.variant).toBe(null);
  });

  test('drops a saved Auto when routing cannot honour it', () => {
    expect(btwModelAvailability(catalog, false)?.(AUTO)).toBe(false);
  });
});
