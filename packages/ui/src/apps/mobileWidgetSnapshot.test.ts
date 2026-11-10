import { describe, expect, test } from 'bun:test';
import { isSessionDirectoryName } from './mobileWidgetSnapshot';

describe('isSessionDirectoryName', () => {
  test('a generated session directory is not a project name', () => {
    expect(isSessionDirectoryName('session-f0c9c9ad-fb19-42b8-9b76-9a7f45b1f632')).toBe(true);
    expect(isSessionDirectoryName('session-7da6934fb6a3')).toBe(true);
  });

  test('real folders stay', () => {
    expect(isSessionDirectoryName('openchamber')).toBe(false);
    expect(isSessionDirectoryName('minibuild')).toBe(false);
    expect(isSessionDirectoryName('session-notes')).toBe(false);
    expect(isSessionDirectoryName('')).toBe(false);
  });
});
