import { describe, expect, test } from 'vitest';

import { completeFormAnswer } from './form-answer.js';

describe('completeFormAnswer', () => {
  test('a hidden field the service never saw goes out with its default', () => {
    const fields = [
      { key: 'color', type: 'string', options: [{ value: 'red' }, { value: 'green' }] },
      { key: 'source', type: 'string', hidden: true, required: true, default: 'telegram' },
      { key: 'force', type: 'boolean' },
    ];
    expect(completeFormAnswer(fields, { color: 'green' })).toEqual({ color: 'green', source: 'telegram', force: false });
  });

  test('a field whose condition does not hold is dropped, even when the service answered it', () => {
    const fields = [
      { key: 'advanced', type: 'boolean', default: false },
      { key: 'details', type: 'string', required: true, when: [{ key: 'advanced', op: 'eq', value: true }] },
      { key: 'reason', type: 'string', when: [{ key: 'details', op: 'neq', value: 'none' }] },
    ];
    expect(completeFormAnswer(fields, { details: 'x', reason: 'y' })).toEqual({ advanced: false });
    expect(completeFormAnswer(fields, { advanced: true, details: 'x', reason: 'y' })).toEqual({ advanced: true, details: 'x', reason: 'y' });
  });

  test('a multiselect condition matches any chosen value', () => {
    const fields = [
      { key: 'tags', type: 'multiselect', options: [{ value: 'a' }, { value: 'b' }] },
      { key: 'why', type: 'string', when: [{ key: 'tags', op: 'eq', value: 'b' }] },
    ];
    expect(completeFormAnswer(fields, { tags: ['a', 'b'], why: 'because' })).toEqual({ tags: ['a', 'b'], why: 'because' });
    expect(completeFormAnswer(fields, { tags: ['a'], why: 'because' })).toEqual({ tags: ['a'] });
  });

  test('a non-finite numeric default is no default', () => {
    expect(completeFormAnswer([{ key: 'n', type: 'number', default: 'Infinity' }], {})).toEqual({});
  });
});
