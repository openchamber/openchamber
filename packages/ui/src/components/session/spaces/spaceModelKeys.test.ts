import { describe, expect, test } from 'bun:test';

import { defaultKeySource, isAccessChoiceComplete, modelGrantOf, type KeySourceChoice, type SpaceModelProviderOption } from './spaceModelKeys';

const choice = (source: KeySourceChoice['source'], change: Partial<KeySourceChoice> = {}): KeySourceChoice => ({ source, envName: '', value: '', ...change });
// A provider the host knows by name, with the API the dialog names, and one of its catalog.
const openrouter: SpaceModelProviderOption = { id: 'openrouter', name: 'OpenRouter', key: { upstream: 'https://openrouter.ai/api/v1', envName: 'OPENROUTER_API_KEY' }, storedKey: true, custom: null };
const go: SpaceModelProviderOption = { id: 'opencode-go', name: 'OpenCode Go', key: { upstream: null, envName: '' }, storedKey: true, custom: null };

describe('where a space\'s key comes from', () => {
  test('starts from the host\'s login, then the key saved in Settings, then a variable, then a key to paste', () => {
    expect(defaultKeySource(openrouter, { name: 'ChatGPT', state: 'usable', expires: null })).toBe('login');
    expect(defaultKeySource(openrouter, null)).toBe('stored');
    expect(defaultKeySource({ ...openrouter, storedKey: false }, null)).toBe('env');
    expect(defaultKeySource({ ...go, storedKey: false }, null)).toBe('typed');
  });

  test('a saved key is complete only while the host keeps one', () => {
    expect(isAccessChoiceComplete(go, choice('stored'))).toBe(true);
    expect(isAccessChoiceComplete({ ...go, storedKey: false }, choice('stored'))).toBe(false);
  });

  test('names the API for a provider known by name, and leaves it to the host\'s catalog for any other', () => {
    expect(modelGrantOf(openrouter, choice('stored'))).toEqual({ kind: 'model', provider: 'openrouter', upstream: 'https://openrouter.ai/api/v1', secret: { kind: 'stored' } });
    expect(modelGrantOf(go, choice('stored'))).toEqual({ kind: 'model', provider: 'opencode-go', secret: { kind: 'stored' } });
    expect(modelGrantOf(go, choice('typed', { value: ' sk-go ' }))).toEqual({ kind: 'model', provider: 'opencode-go', secret: { kind: 'typed', value: 'sk-go' } });
  });
});
