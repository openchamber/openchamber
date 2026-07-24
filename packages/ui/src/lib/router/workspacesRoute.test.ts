import { describe, expect, test } from 'bun:test';
import { parseRoute } from './parseRoute';
import { isMainTabAvailable } from './types';

describe('Secure Workspaces route', () => {
  test('parses the first-class workspaces tab', () => {
    expect(parseRoute(new URLSearchParams('tab=workspaces')).tab).toBe('workspaces');
  });

  test('is available to web surfaces and hidden from VS Code', () => {
    expect(isMainTabAvailable('workspaces', { isVSCode: false })).toBe(true);
    expect(isMainTabAvailable('workspaces', { isVSCode: true })).toBe(false);
  });
});
