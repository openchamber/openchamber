import { describe, expect, test } from 'bun:test';
import { describeUiBlockAnswer, describeUiBlockReplyAnswer, pageAnswerSummary, uiBlockKey } from './answer';

describe('describeUiBlockAnswer', () => {
  const fields = [
    { name: 'database', label: 'Which database do you use?' },
    { name: 'tags', label: 'Tags' },
    { name: 'notes', label: 'Notes' },
  ];

  test('reads as what the user said: the button, then each filled field', () => {
    expect(describeUiBlockAnswer(fields, { button: 'Send', values: { database: 'PostgreSQL', tags: ['a', 'b'], notes: '  ' } }, 'Note'))
      .toBe('Send\nWhich database do you use? PostgreSQL\nTags: a, b');
  });

  test('a button value names what the pressed button is about', () => {
    expect(describeUiBlockAnswer(fields, { button: 'Take it', value: '#5931', values: {} }, 'Note')).toBe('Take it · #5931');
  });

  test('the user\'s note comes last under its label', () => {
    expect(describeUiBlockAnswer(fields, { button: 'Minimal fix', values: {}, note: 'add a regression test' }, 'Note'))
      .toBe('Minimal fix\nNote: add a regression test');
  });

  test('a page summary fits the server limit', () => {
    expect(pageAnswerSummary('x'.repeat(800))).toHaveLength(500);
  });
});

describe('describeUiBlockReplyAnswer', () => {
  test('lists one choice per decision, the fields, and what was left without a choice', () => {
    const text = describeUiBlockReplyAnswer([{ name: 'note', label: 'Note' }], {
      picks: [{ button: 'Take it', value: '#12' }, { button: 'Later', value: '#15' }],
      values: { note: 'by Friday' },
      skipped: ['#18', ''],
    });
    expect(text).toBe([
      'The user answered the UI block in your previous reply:',
      '- #12: Take it',
      '- #15: Later',
      '- Note: by Friday',
      'They sent it without a choice for: #18, the buttons that name no item.',
    ].join('\n'));
  });
});

test('a note goes under its decision, and a note alone answers one', () => {
  const text = describeUiBlockReplyAnswer([], {
    picks: [{ button: 'Take it', value: '#12', note: 'after the release' }, { value: '#15', note: 'ask Yulia first' }],
    values: {},
    skipped: [],
  });
  expect(text).toBe([
    'The user answered the UI block in your previous reply:',
    '- #12: Take it',
    '  Their note: after the release',
    '- #15: no option chosen',
    '  Their note: ask Yulia first',
  ].join('\n'));
});

describe('uiBlockKey', () => {
  test('is stable for a source and differs between sources', () => {
    expect(uiBlockKey('root = Stack([])')).toBe(uiBlockKey('root = Stack([])'));
    expect(uiBlockKey('root = Stack([])')).not.toBe(uiBlockKey('root = Stack([x])'));
  });
});
