import { describe, expect, it } from 'vitest';

import { miniMaxStatusError } from './minimax-status.js';

describe('MiniMax status mapping', () => {
  it('keeps absent responses and coercible success codes successful', () => {
    for (const response of [null, undefined, { status_code: 0 }, { status_code: '0' }, { status_code: null }, { status_code: false }]) {
      expect(miniMaxStatusError(response)).toBeNull();
    }
  });

  it('coerces unchecked codes and messages', () => {
    expect(miniMaxStatusError({ status_code: '1004' })).toBe("MiniMax doesn't share limits for this key");
    expect(miniMaxStatusError({ status_code: 2049, status_msg: 42 })).toBe('42');
    expect(miniMaxStatusError({ status_code: 2049, status_msg: ' rejected ' })).toBe('rejected');
    expect(miniMaxStatusError({ status_code: 2049, status_msg: ' ' })).toBe('API error: 2049');
    expect(miniMaxStatusError({})).toBe('API error: unknown');
  });

  it('preserves inherited status fields', () => {
    expect(miniMaxStatusError(Object.create({ status_code: 2049, status_msg: 'inherited' }))).toBe('inherited');
  });
});
