import { describe, expect, test } from 'bun:test';
import { isSupportedOpenUIAction, isTerminalOpenUIAction } from '../../../../../web/shared/openui/actions.js';
import type { ActionPlan } from '@openuidev/lang-core';

describe('OpenUI actions', () => {
  test('allows local action plans', () => {
    const action: ActionPlan = { steps: [{ type: 'set', target: '$query', valueAST: { k: 'Str', v: 'next' } }] };
    expect(isSupportedOpenUIAction(action)).toBe(true);
    expect(isTerminalOpenUIAction(action)).toBe(false);
  });

  test('allows one terminal host action and rejects mixed or unknown plans', () => {
    const submit: ActionPlan = { steps: [{ type: 'continue_conversation', message: 'Selected' }] };
    expect(isSupportedOpenUIAction(submit)).toBe(true);
    expect(isTerminalOpenUIAction(submit)).toBe(true);
    expect(isSupportedOpenUIAction({ steps: [...submit.steps, { type: 'reset', targets: ['name'] }] })).toBe(false);
    expect(isSupportedOpenUIAction({ steps: [{ type: 'run', refType: 'query' }] })).toBe(false);
  });
});
