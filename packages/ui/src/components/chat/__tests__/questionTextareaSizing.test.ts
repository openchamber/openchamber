import { describe, expect, test } from 'bun:test';
import { QUESTION_CUSTOM_TEXTAREA_MIN_HEIGHT, getQuestionCustomTextareaHeight } from '../questionTextareaSizing';

describe('getQuestionCustomTextareaHeight', () => {
  test('exports the initial textarea height', () => {
    expect(QUESTION_CUSTOM_TEXTAREA_MIN_HEIGHT).toBe(40);
  });

  test('returns null when the textarea is already at the target height', () => {
    expect(getQuestionCustomTextareaHeight({ scrollHeight: 60, currentHeight: 60 })).toBeNull();
  });

  test('clamps textarea height between two and ten lines', () => {
    expect(getQuestionCustomTextareaHeight({ scrollHeight: 10, currentHeight: 0 })).toBe(40);
    expect(getQuestionCustomTextareaHeight({ scrollHeight: 120, currentHeight: 0 })).toBe(120);
    expect(getQuestionCustomTextareaHeight({ scrollHeight: 260, currentHeight: 0 })).toBe(200);
  });
});
