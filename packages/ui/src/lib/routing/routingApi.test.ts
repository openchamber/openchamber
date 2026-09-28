import { describe, expect, test } from 'bun:test';
import { routingStateSchema } from './routingApi';

const base = {
  available: true,
  autoReady: false,
  jevAvailable: true,
  tokenPresent: false,
  jevSource: 'zen-free',
  config: null,
  builtins: [],
};

const legacySources = [
  { id: 'zen-promo', usable: true },
  { id: 'zen-key', usable: false },
  { id: 'typesafe', usable: false },
];

describe('routingStateSchema', () => {
  test('prefers the full classification over the legacy classifier view', () => {
    const state = routingStateSchema.parse({
      ...base,
      classifier: null,
      classification: {
        selected: 'openrouter',
        effective: 'openrouter',
        sources: [...legacySources, { id: 'openrouter', usable: true }, { id: 'vercel', usable: false }],
      },
    });
    expect(state.classifier?.effective).toBe('openrouter');
    expect(state.classifier?.sources.map((source) => source.id)).toEqual(['zen-promo', 'zen-key', 'typesafe', 'openrouter', 'vercel']);
  });

  test('reads a v2.0.2 server, which sends only the classifier view', () => {
    const state = routingStateSchema.parse({ ...base, classifier: { selected: 'zen-promo', effective: 'zen-promo', sources: legacySources } });
    expect(state.classifier?.selected).toBe('zen-promo');
    expect(state.classifier?.sources).toHaveLength(3);
  });

  test('a source this build does not know neither fails the state nor shows up', () => {
    const state = routingStateSchema.parse({
      ...base,
      classification: {
        selected: 'cloudflare',
        effective: 'zen-promo',
        sources: [...legacySources, { id: 'cloudflare', usable: true }],
      },
    });
    expect(state.classifier?.selected).toBeNull();
    expect(state.classifier?.effective).toBe('zen-promo');
    expect(state.classifier?.sources.map((source) => source.id)).toEqual(['zen-promo', 'zen-key', 'typesafe']);
  });
});
