import { describe, expect, test } from 'bun:test';

import { autoSelectedKeyProvider, type KeyProvider } from './keyProviders';

const provider = (id: string, matches: boolean): KeyProvider => ({ id, name: id, keyId: `key-${id}`, matches, approved: false });

describe('autoSelectedKeyProvider', () => {
  test('takes the one provider whose address is the voice server address', () => {
    expect(autoSelectedKeyProvider([provider('other', false), provider('gateway', true)])?.id).toBe('gateway');
  });

  test('takes none for no provider, and none for two with the same address', () => {
    expect(autoSelectedKeyProvider([])).toBeNull();
    expect(autoSelectedKeyProvider([provider('other', false)])).toBeNull();
    expect(autoSelectedKeyProvider([provider('gateway', true), provider('twin', true)])).toBeNull();
  });
});
