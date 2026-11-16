import { describe, expect, test } from 'bun:test';

import { guestUpdateFingerprint } from './update-notice.ts';

describe('guestUpdateFingerprint', () => {
  test('stays the same in any order, and changes with a new version', () => {
    const one = guestUpdateFingerprint({ a: { version: '1.1.0' }, b: { version: '2.0.0' } });
    expect(guestUpdateFingerprint({ b: { version: '2.0.0' }, a: { version: '1.1.0' } })).toBe(one);
    expect(guestUpdateFingerprint({ a: { version: '1.2.0' }, b: { version: '2.0.0' } })).not.toBe(one);
  });
});
