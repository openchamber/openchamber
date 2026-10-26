import { describe, expect, it } from 'vitest';
import { forkRemoteName } from './contributor-remote.js';

describe('contributor fork remote names', () => {
  it.each([
    ['Alice', 'pr-alice'],
    ['  Team/Sub Group  ', 'pr-team-sub-group'],
    ['---Alice---', 'pr-alice'],
    ['a...b__c', 'pr-a...b__c'],
    ['a---b', 'pr-a-b'],
    ['你好', 'pr-head'],
    ['', 'pr-head'],
    [null, 'pr-head'],
    [undefined, 'pr-head'],
    [false, 'pr-head'],
    [0, 'pr-head'],
    [42, 'pr-42'],
  ])('normalizes %s to %s', (owner, expected) => {
    expect(forkRemoteName(owner)).toBe(expected);
  });
});
