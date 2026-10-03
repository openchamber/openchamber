import { describe, expect, test } from 'bun:test';

import { resolveBtwSelection } from './useBtwStore';

const AGENTS = [
  { name: 'build', hidden: false, mode: 'primary' as const },
  { name: 'plan', hidden: false, mode: 'primary' as const },
];
const COMPOSER = { providerId: 'omniroute', modelId: 'orchestrator' };
const SAVED_DEAD = { providerId: 'opencode-omniroute-live', modelId: 'orchestrator' };

describe('resolveBtwSelection', () => {
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
