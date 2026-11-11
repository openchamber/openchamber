import { expect, test } from 'bun:test';

import { parseOmniQuery, setOmniFlag } from './omniQuery';

test('parses quoted and case-insensitive flags while retaining unknown input', () => {
  expect(parseOmniQuery('Bug PROJECT:"My Project" author:AGENT unknown:no')).toEqual({ text: 'Bug unknown:no', filters: { project: 'My Project', author: 'assistant' } });
});

test('keeps incomplete and unknown flags in text', () => {
  expect(parseOmniQuery('in: project:"unfinished')).toEqual({ text: 'in: project:"unfinished', filters: {} });
});

test('only extracts complete quote-aware flag tokens', () => {
  expect(parseOmniQuery('in:"active"junk project:abc"unfinished')).toEqual({ text: 'in:"active"junk project:abc"unfinished', filters: {} });
  expect(parseOmniQuery('project:"unfinished in:active')).toEqual({ text: 'project:"unfinished in:active', filters: {} });
  expect(setOmniFlag('in:"active"junk project:abc"unfinished', 'lifecycle', 'archived')).toBe('in:archived in:"active"junk project:abc"unfinished');
});

test('sets and removes one flag without dropping query text', () => {
  expect(setOmniFlag('find project:old', 'project', 'new value')).toBe('find project:"new value"');
  expect(setOmniFlag('find in:active', 'lifecycle', null)).toBe('find');
});

test('prepends a filter before an unfinished quote', () => {
  expect(parseOmniQuery(setOmniFlag('project:"unfinished', 'lifecycle', 'archived'))).toEqual({
    text: 'project:"unfinished', filters: { lifecycle: 'archived' },
  });
});
