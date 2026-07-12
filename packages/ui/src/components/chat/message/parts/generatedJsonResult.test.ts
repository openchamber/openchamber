import { describe, expect, test } from 'bun:test';

import { parseGeneratedJsonResult } from './generatedJsonResult';

describe('parseGeneratedJsonResult', () => {
  test('parses a full pull request JSON result', () => {
    expect(parseGeneratedJsonResult('{"title":"Side task","body":"Details"}')).toEqual({
      kind: 'pr',
      title: 'Side task',
      body: 'Details',
      raw: JSON.stringify({ title: 'Side task', body: 'Details' }, null, 2),
    });
  });

  test('parses a full fenced JSON result', () => {
    expect(parseGeneratedJsonResult('```json\n{"subject":"Fix parser","highlights":["Narrow detection"]}\n```')).toEqual({
      kind: 'commit',
      subject: 'Fix parser',
      highlights: ['Narrow detection'],
      raw: JSON.stringify({ subject: 'Fix parser', highlights: ['Narrow detection'] }, null, 2),
    });
  });

  test('ignores JSON examples embedded in markdown prose', () => {
    const markdown = [
      'Recommended endpoint:',
      '',
      '```json',
      '{',
      '  "title": "Side task",',
      '  "prompt": "Investigate X"',
      '}',
      '```',
      '',
      'This should stay markdown.',
    ].join('\n');

    expect(parseGeneratedJsonResult(markdown)).toBeNull();
  });
});
