import { expect, test } from 'bun:test';

import { splitNoteTitle } from './knowledgeFormat';

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
