import { describe, expect, test } from 'bun:test';
import { FORM_CUSTOM_TEXTAREA_MIN_HEIGHT, getFormCustomTextareaHeight } from '../formTextareaSizing';

describe('getFormCustomTextareaHeight', () => {
  test('exports the initial textarea height', () => {
    expect(FORM_CUSTOM_TEXTAREA_MIN_HEIGHT).toBe(40);
  });

  test('returns null when the textarea is already at the target height', () => {
    expect(getFormCustomTextareaHeight({ scrollHeight: 60, currentHeight: 60 })).toBeNull();
  });

  test('clamps textarea height between two and ten lines', () => {
    expect(getFormCustomTextareaHeight({ scrollHeight: 10, currentHeight: 0 })).toBe(40);
    expect(getFormCustomTextareaHeight({ scrollHeight: 120, currentHeight: 0 })).toBe(120);
    expect(getFormCustomTextareaHeight({ scrollHeight: 260, currentHeight: 0 })).toBe(200);
  });
});
