import { describe, expect, test } from 'bun:test';

import { normalizeAssistantAnswerAction } from './assistantAnswerAction';

describe('normalizeAssistantAnswerAction', () => {
  test('keeps both supported values', () => {
    expect(normalizeAssistantAnswerAction('start-from-answer')).toBe('start-from-answer');
    expect(normalizeAssistantAnswerAction('fork-session')).toBe('fork-session');
  });

  test('uses start-from-answer for missing or invalid values', () => {
    expect(normalizeAssistantAnswerAction(undefined)).toBe('start-from-answer');
    expect(normalizeAssistantAnswerAction('invalid')).toBe('start-from-answer');
  });
});
