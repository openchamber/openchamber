import { describe, expect, test } from 'bun:test';
import {
  WORK_STATUS_SECTION_IDS,
  WORK_STATUS_SECTION_LABEL_KEYS,
  isWorkStatusSectionVisible,
  sanitizeWorkStatusHiddenSections,
} from './sections';

describe('section registry', () => {
  test('every section has a label, and every label a section', () => {
    // One list drives the panel and the dialog; a mismatch means a section the
    // user cannot switch, or a switch for nothing.
    expect(Object.keys(WORK_STATUS_SECTION_LABEL_KEYS).sort())
      .toEqual([...WORK_STATUS_SECTION_IDS].sort());
  });
});

describe('isWorkStatusSectionVisible', () => {
  test('everything is visible by default', () => {
    // Storing the hidden set means a section added later is on for everyone,
    // rather than invisible to whoever had settings saved before it existed.
    expect(isWorkStatusSectionVisible([], 'usage')).toBe(true);
    expect(isWorkStatusSectionVisible(undefined, 'usage')).toBe(true);
    expect(isWorkStatusSectionVisible(null, 'usage')).toBe(true);
  });

  test('hides exactly the listed section', () => {
    expect(isWorkStatusSectionVisible(['usage'], 'usage')).toBe(false);
    expect(isWorkStatusSectionVisible(['usage'], 'tasks')).toBe(true);
  });
});

describe('sanitizeWorkStatusHiddenSections', () => {
  test('keeps known ids and drops everything else', () => {
    expect(sanitizeWorkStatusHiddenSections(['usage', 'nope', 42, null, 'tasks']))
      .toEqual(['usage', 'tasks']);
  });

  test('deduplicates', () => {
    expect(sanitizeWorkStatusHiddenSections(['usage', 'usage'])).toEqual(['usage']);
  });

  test('treats a non-array payload as no preference', () => {
    expect(sanitizeWorkStatusHiddenSections(undefined)).toEqual([]);
    expect(sanitizeWorkStatusHiddenSections('usage')).toEqual([]);
    expect(sanitizeWorkStatusHiddenSections({ usage: true })).toEqual([]);
  });
});
