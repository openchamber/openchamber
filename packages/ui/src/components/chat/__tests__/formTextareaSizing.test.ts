import { describe, expect, test } from 'bun:test';
import { getFormCustomTextareaHeight } from '../formTextareaSizing';

describe('getFormCustomTextareaHeight', () => {
  test('clamps textarea height between two and ten lines', () => {
    expect(getFormCustomTextareaHeight(10)).toBe(40);
    expect(getFormCustomTextareaHeight(120)).toBe(120);
    expect(getFormCustomTextareaHeight(260)).toBe(200);
  });
});
