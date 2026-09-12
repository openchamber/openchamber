import { describe, expect, test } from 'bun:test';

import { parseInstallInput } from './install.ts';

describe('parseInstallInput', () => {
  test('sends a folder or zip path and an https url', () => {
    expect(parseInstallInput('/tmp/panel')).toEqual({ ok: true, request: { path: '/tmp/panel' } });
    expect(parseInstallInput('/tmp/panel.zip')).toEqual({ ok: true, request: { path: '/tmp/panel.zip' } });
    expect(parseInstallInput('https://github.com/acme/panel.git')).toEqual({
      ok: true,
      request: { url: 'https://github.com/acme/panel.git' },
    });
    expect(parseInstallInput('HTTPS://example.com/panel.zip')).toEqual({
      ok: true,
      request: { url: 'HTTPS://example.com/panel.zip' },
    });
  });

  test('refuses empty, http, and other schemes', () => {
    expect(parseInstallInput('')).toEqual({ ok: false, code: 'invalid-path' });
    expect(parseInstallInput('   ')).toEqual({ ok: false, code: 'invalid-path' });
    expect(parseInstallInput('http://github.com/acme/panel.git')).toEqual({ ok: false, code: 'invalid-url' });
    expect(parseInstallInput('file:///tmp/panel')).toEqual({ ok: false, code: 'invalid-url' });
    expect(parseInstallInput('git@github.com:acme/panel.git')).toEqual({ ok: false, code: 'invalid-path' });
    expect(parseInstallInput('relative/panel')).toEqual({ ok: false, code: 'invalid-path' });
  });
});
