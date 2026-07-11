import { describe, expect, test } from 'bun:test';

import { resolveMenuActionEventSource } from './useMenuActions';

describe('resolveMenuActionEventSource', () => {
  test('uses the desktop bridge exclusively when Electron exposes it', () => {
    expect(resolveMenuActionEventSource({
      listen: async () => () => {},
    })).toBe('bridge');
  });

  test('uses DOM events when there is no desktop bridge', () => {
    expect(resolveMenuActionEventSource(null)).toBe('dom');
    expect(resolveMenuActionEventSource({})).toBe('dom');
  });
});
