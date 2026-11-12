import { beforeEach, describe, expect, test } from 'bun:test';
import { recordSessionActionFailure, resetSessionActionFailures, takeSessionActionFailure } from './session-action-failures';

describe('session action failures', () => {
  beforeEach(() => resetSessionActionFailures());

  test('hands the first failure among the asked sessions to one reader and forgets the rest', () => {
    recordSessionActionFailure('b', new Error('second'));
    recordSessionActionFailure('a', new Error('first'));

    expect(takeSessionActionFailure(['a', 'b'])?.message).toBe('first');
    expect(takeSessionActionFailure(['a', 'b'])).toBeNull();
  });

  test('keeps the newest error per session and drops the oldest sessions past the bound', () => {
    recordSessionActionFailure('a', new Error('old'));
    recordSessionActionFailure('a', new Error('new'));
    for (let index = 0; index < 250; index += 1) recordSessionActionFailure(`s${index}`, new Error(String(index)));

    expect(takeSessionActionFailure(['a'])).toBeNull();
    expect(takeSessionActionFailure(['s249'])?.message).toBe('249');
  });
});
