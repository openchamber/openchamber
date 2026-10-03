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

  test('accepts SSH URL and scp-style Git addresses', () => {
    for (const url of ['git@github.com:acme/panel.git', 'git@github.com:acme/panel.git#main', 'ssh://git@github.com/acme/panel.git', 'ssh://git@example.com:2222/acme/panel.git']) {
      expect(parseInstallInput(url)).toEqual({ ok: true, request: { url } });
    }
    expect(parseInstallInput('C:\\projects\\panel')).toEqual({ ok: true, request: { path: 'C:\\projects\\panel' } });
  });

  test('refuses empty, http, and other schemes', () => {
    expect(parseInstallInput('')).toEqual({ ok: false, code: 'invalid-path' });
    expect(parseInstallInput('   ')).toEqual({ ok: false, code: 'invalid-path' });
    expect(parseInstallInput('http://github.com/acme/panel.git')).toEqual({ ok: false, code: 'invalid-url' });
    expect(parseInstallInput('file:///tmp/panel')).toEqual({ ok: false, code: 'invalid-url' });
    expect(parseInstallInput('relative/panel')).toEqual({ ok: false, code: 'invalid-path' });
  });
});

describe('installation diagnostics', () => {
  test('sends the selected identity for Git URLs, not local folders', async () => {
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (_input, options) => {
      const body = JSON.parse(String(options?.body));
      if (body.url) expect(body.gitIdentityId).toBe('work');
      else expect(body.gitIdentityId).toBeUndefined();
      return Response.json({ error: 'clone-failed' }, { status: 400 });
    });
    try {
      await installGuest('git@github.com:acme/panel.git', { gitIdentityId: 'work' });
      await installGuest('/tmp/panel', { gitIdentityId: 'work' });
    } finally { fetch.mockRestore(); }
  });
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
