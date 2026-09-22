import { describe, expect, test } from 'bun:test';
import { orderProvidersByUserOrder } from './providerOrdering';

const providers = [
  { id: 'anthropic' },
  { id: 'openai' },
  { id: 'google' },
];

describe('orderProvidersByUserOrder', () => {
  test('returns providers unchanged when no order is set', () => {
    expect(orderProvidersByUserOrder(providers, [])).toBe(providers);
  });

  test('sorts ranked providers by the user order', () => {
    const ordered = orderProvidersByUserOrder(providers, ['google', 'anthropic', 'openai']);
    expect(ordered.map((provider) => provider.id)).toEqual(['google', 'anthropic', 'openai']);
  });

  test('keeps unranked providers after ranked ones in their original order', () => {
    const ordered = orderProvidersByUserOrder(providers, ['openai']);
    expect(ordered.map((provider) => provider.id)).toEqual(['openai', 'anthropic', 'google']);
  });

  test('ignores order entries that do not match any provider', () => {
    const ordered = orderProvidersByUserOrder(providers, ['missing', 'google', 'also-missing']);
    expect(ordered.map((provider) => provider.id)).toEqual(['google', 'anthropic', 'openai']);
  });
});
