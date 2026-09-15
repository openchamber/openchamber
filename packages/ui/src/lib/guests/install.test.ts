import { describe, expect, spyOn, test } from 'bun:test';

import { installGuest, parseInstallInput, uploadGuestZip } from './install.ts';

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

describe('installation diagnostics', () => {
  for (const status of [401, 403, 404, 500, 502]) test(`preserves HTTP ${status} without copying the response body`, async () => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('private server details', { status }));
    try {
      expect(await installGuest('https://github.com/acme/extension')).toEqual({
        ok: false, code: 'failed',
        diagnostic: { method: 'POST', path: '/api/guests', kind: 'http', status },
      });
    } finally { fetch.mockRestore(); }
  });

  test('distinguishes a successful HTML fallback from a transport failure', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>Login page</html>'));
    try {
      expect(await installGuest('/tmp/extension')).toEqual({
        ok: false, code: 'failed',
        diagnostic: { method: 'POST', path: '/api/guests', kind: 'invalid-response', status: 200 },
      });
      fetch.mockRejectedValue(new Error('Connection failed with sensitive connection details'));
      expect(await installGuest('/tmp/extension')).toEqual({
        ok: false, code: 'failed', diagnostic: { method: 'POST', path: '/api/guests', kind: 'network' },
      });
    } finally { fetch.mockRestore(); }
  });

  test('retains actionable install errors and identifies the upload route', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'host-too-old', required: '9.0.0', id: 'hello' }, { status: 400 }));
    try {
      expect(await uploadGuestZip(new File(['fixture'], 'extension.zip'))).toEqual({
        ok: false, code: 'host-too-old', required: '9.0.0', id: 'hello',
        diagnostic: { method: 'POST', path: '/api/guests/upload', kind: 'http', status: 400 },
      });
    } finally { fetch.mockRestore(); }
  });
});
