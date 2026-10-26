import { describe, expect, test } from 'bun:test';

import { acmeTrackerDescriptor, linearLikeTrackerDescriptor } from './descriptor.fixture';
import { LINEAR_URL_CASES } from './linearUrlCases.fixture';
import { createTrackerUrlMatcher } from './matchTrackerUrl';

describe('createTrackerUrlMatcher', () => {
  const match = createTrackerUrlMatcher([linearLikeTrackerDescriptor()]);

  // The same table the server's `matchLinearUrl` follows.
  for (const [url, identifier] of LINEAR_URL_CASES) {
    test(`reads ${JSON.stringify(url)} as ${identifier ?? 'no item'}`, () => {
      expect(match(url)).toEqual(identifier ? { provider: 'linear', identifier } : null);
    });
  }

  test('reads each tracker through its own patterns, in registry order', () => {
    const both = createTrackerUrlMatcher([linearLikeTrackerDescriptor(), acmeTrackerDescriptor()]);
    expect(both('https://tickets.example.com/t/OPS-7')).toEqual({ provider: 'acme-tickets', identifier: 'OPS-7' });
    expect(both('https://linear.app/openchamber/issue/ENG-1')).toEqual({ provider: 'linear', identifier: 'ENG-1' });
  });

  test('matches nothing without served trackers, and skips a pattern that does not compile', () => {
    expect(createTrackerUrlMatcher([])('https://linear.app/openchamber/issue/ENG-1')).toBeNull();
    const broken = createTrackerUrlMatcher([linearLikeTrackerDescriptor({ urlPatterns: [{ host: 'linear.app', path: '([' }] })]);
    expect(broken('https://linear.app/openchamber/issue/ENG-1')).toBeNull();
  });
});
