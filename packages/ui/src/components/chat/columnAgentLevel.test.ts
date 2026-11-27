import { afterEach, describe, expect, test } from 'bun:test';
import { useSelectionStore } from '@/sync/selection-store';
import { useUIStore } from '@/stores/useUIStore';
import { carryColumnLevelToAgent } from './columnAgentLevel';

const SESSION = 'btw-pending:ses_column_level';
const MODEL = { providerId: 'openai', modelId: 'opus' };
const savedFor = (agent: string) => useSelectionStore.getState().getAgentModelVariantForSession(SESSION, agent, MODEL.providerId, MODEL.modelId);

describe('[issue-6058] a column agent pick and the level on screen', () => {
  afterEach(() => {
    useUIStore.setState({ keepModelOnAgentSwitch: false });
    useSelectionStore.getState().clearSessionSelections(SESSION);
  });

  test('without the setting a level the agent remembers stays, and a gap is filled only from the menu', () => {
    useSelectionStore.getState().saveAgentModelVariantForSession(SESSION, 'plan', MODEL.providerId, MODEL.modelId, 'high');

    carryColumnLevelToAgent(SESSION, 'plan', MODEL, 'low', { fillUnremembered: true });
    carryColumnLevelToAgent(SESSION, 'review', MODEL, 'low', { fillUnremembered: false });
    carryColumnLevelToAgent(SESSION, 'build', MODEL, 'low', { fillUnremembered: true });

    expect([savedFor('plan'), savedFor('review'), savedFor('build')]).toEqual(['high', undefined, 'low']);
  });

  test('with the setting the level on screen replaces what the agent remembered, an inherited one included', () => {
    useUIStore.setState({ keepModelOnAgentSwitch: true });
    useSelectionStore.getState().saveAgentModelVariantForSession(SESSION, 'plan', MODEL.providerId, MODEL.modelId, 'high');
    useSelectionStore.getState().saveAgentModelVariantForSession(SESSION, 'review', MODEL.providerId, MODEL.modelId, 'high');

    carryColumnLevelToAgent(SESSION, 'plan', MODEL, 'low', { fillUnremembered: false });
    carryColumnLevelToAgent(SESSION, 'review', MODEL, undefined, { fillUnremembered: true });

    expect([savedFor('plan'), savedFor('review')]).toEqual(['low', undefined]);
  });
});
