import { describe, expect, test } from 'bun:test';

import { isContextPanelMode, isPluginContextPanelMode } from './modes';

describe('context panel modes', () => {
  test('accepts server browser as a built-in surface', () => {
    expect(isContextPanelMode('server-browser')).toBe(true);
    expect(isPluginContextPanelMode('server-browser')).toBe(false);
  });

  test('accepts installed extension surface identities', () => {
    expect(isContextPanelMode('plugin:hello-world')).toBe(true);
    expect(isPluginContextPanelMode('plugin:hello-world')).toBe(true);
  });

  test('rejects unknown built-ins and malformed extension identities', () => {
    expect(isContextPanelMode('unknown')).toBe(false);
    expect(isContextPanelMode('plugin:')).toBe(false);
    expect(isContextPanelMode('plugin:Hello')).toBe(false);
  });
});
