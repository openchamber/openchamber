import { expect, test } from 'bun:test';

import { formatPlanCost, formatTokenCount, splitNoteTitle } from './knowledgeFormat';

test('the first non-empty line is the title and the rest is the preview', () => {
  expect(splitNoteTitle('\n\nRelease checklist\n- tag\n- push')).toEqual({ title: 'Release checklist', rest: '- tag\n- push' });
});

test('markdown markers do not show in the title', () => {
  expect(splitNoteTitle('## Ports').title).toBe('Ports');
  expect(splitNoteTitle('- first item').title).toBe('first item');
  expect(splitNoteTitle('**Bold lead**\nbody').title).toBe('Bold lead');
  expect(splitNoteTitle('`OPENCODE_PORT` must be free').title).toBe('`OPENCODE_PORT` must be free');
});

test('a one-line note has no preview', () => {
  expect(splitNoteTitle('Only a title')).toEqual({ title: 'Only a title', rest: '' });
});

test('plan cost badge: free, sub-cent, and cent-or-more sessions', () => {
  expect(formatPlanCost(0)).toBe('$0');
  expect(formatPlanCost(0.004)).toBe('<$0.01');
  expect(formatPlanCost(0.428)).toBe('$0.43');
  expect(formatPlanCost(12.5)).toBe('$12.50');
});

test('token counts compact to k and M', () => {
  expect(formatTokenCount(950)).toBe('950');
  expect(formatTokenCount(142_000)).toBe('142k');
  expect(formatTokenCount(1_500_000)).toBe('1.5M');
});
