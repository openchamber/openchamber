import { describe, expect, test } from 'bun:test';

import { guestUrlTarget } from './open-url.ts';

const desktop = { panelAvailable: true, directory: '/work/app', linksInPanel: false };

describe('guestUrlTarget', () => {
  test('a local address opens in the browser panel', () => {
    expect(guestUrlTarget('http://localhost:8088', desktop)).toBe('browser-panel');
    expect(guestUrlTarget('http://127.0.0.1:3000/api', desktop)).toBe('browser-panel');
    expect(guestUrlTarget('http://[::1]:5173', desktop)).toBe('browser-panel');
  });

  test('another site follows the links setting', () => {
    expect(guestUrlTarget('https://github.com/acme/repo', desktop)).toBe('system');
    expect(guestUrlTarget('https://github.com/acme/repo', { ...desktop, linksInPanel: true })).toBe('browser-panel');
  });

  test('without the panel or a project, everything opens in the system browser', () => {
    expect(guestUrlTarget('http://localhost:8088', { ...desktop, panelAvailable: false })).toBe('system');
    expect(guestUrlTarget('http://localhost:8088', { ...desktop, directory: null })).toBe('system');
  });
});
