import { describe, expect, test } from 'bun:test';

import { getSearchablePartId, getSourcePartIndex } from './chatSearchPartIdentity';

describe('getSearchablePartId', () => {
  test('keeps ID-less duplicate parts distinct by authoritative source index', () => {
    const first = { type: 'text', text: 'same' };
    const second = { type: 'text', text: 'same' };

    expect(getSearchablePartId('message-1', first, 0)).not.toBe(
      getSearchablePartId('message-1', second, 1),
    );
    expect(getSearchablePartId('message-1', first, 0)).toBe(
      getSearchablePartId('message-1', { ...first }, 0),
    );
  });
});

describe('getSourcePartIndex', () => {
  test('returns the raw message index after render filtering', () => {
    const compaction = { type: 'compaction' };
    const text = { type: 'text', text: 'needle' };
    const source = [compaction, text];
    const filtered = source.filter((part) => part.type === 'text');

    expect(getSourcePartIndex(source, filtered[0], 0)).toBe(1);
  });
});
