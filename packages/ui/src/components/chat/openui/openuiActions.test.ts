import { describe, expect, test } from 'bun:test';
import { supportedOpenUIAction, isTerminalOpenUIAction } from '../../../../../web/shared/openui/actions.js';
import type { ActionPlan } from '@openuidev/lang-core';

describe('OpenUI actions', () => {
  test('allows local action plans', () => {
    const action: ActionPlan = { steps: [{ type: 'set', target: '$query', valueAST: { k: 'Str', v: 'next' } }] };
    expect(supportedOpenUIAction.safeParse(action).success).toBe(true);
    expect(isTerminalOpenUIAction(action)).toBe(false);
  });

  test('allows one terminal host action and rejects mixed or unknown plans', () => {
    const submit: ActionPlan = { steps: [{ type: 'continue_conversation', message: 'Selected' }] };
    expect(supportedOpenUIAction.safeParse(submit).success).toBe(true);
    expect(isTerminalOpenUIAction(submit)).toBe(true);
    expect(supportedOpenUIAction.safeParse({ steps: [...submit.steps, { type: 'reset', targets: ['name'] }] }).success).toBe(false);
    expect(supportedOpenUIAction.safeParse({ steps: [{ type: 'run', refType: 'query' }] }).success).toBe(false);
    expect(supportedOpenUIAction.safeParse({ steps: [] }).success).toBe(false);
    expect(supportedOpenUIAction.safeParse(null).success).toBe(false);
  });
});
