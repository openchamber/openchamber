import { describe, expect, test } from 'bun:test';
import { createRequestSecurityRuntime } from './request-security.js';

const createRuntime = () => createRequestSecurityRuntime({
  readSettingsFromDiskMigrated: async () => ({}),
});

describe('request security runtime', () => {
  test('allows packaged client origins for remote client transports', async () => {
    const runtime = createRuntime();

    await expect(runtime.isRequestOriginAllowed({
      headers: {
        origin: 'openchamber-ui://app',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).resolves.toBe(true);

    await expect(runtime.isRequestOriginAllowed({
      headers: {
        origin: 'capacitor://localhost',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).resolves.toBe(true);

    // Android Capacitor WebView (androidScheme 'https') reports this origin.
    await expect(runtime.isRequestOriginAllowed({
      headers: {
        origin: 'https://localhost',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).resolves.toBe(true);
  });

  test('rejects unknown origins', async () => {
    const runtime = createRuntime();

    await expect(runtime.isRequestOriginAllowed({
      headers: {
        origin: 'https://evil.example.com',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).resolves.toBe(false);
  });

  test('picks the cookie for this instance port when a browser shares jars across LAN ports', () => {
    const runtime = createRuntime();
    // Two instances on one LAN IP: the browser sends BOTH session cookies to
    // either port (browsers key cookie jars on host, not port — issue #2377).
    const req = {
      headers: {
        host: '192.168.0.1:3001',
        cookie: 'oc_ui_session_3000=token-a; oc_ui_session_3001=token-b',
      },
    };
    expect(runtime.getUiSessionTokenFromRequest(req)).toBe('token-b');
  });

  test('falls back to the bare cookie for loopback without an explicit port', () => {
    const runtime = createRuntime();
    const req = {
      headers: { host: '192.168.0.1', cookie: 'oc_ui_session=token-bare' },
    };
    expect(runtime.getUiSessionTokenFromRequest(req)).toBe('token-bare');
  });

  test('returns null when no session cookie is present', () => {
    const runtime = createRuntime();
    const req = { headers: { host: '192.168.0.1:3000', cookie: 'theme=dark; oc_url_token=x' } };
    expect(runtime.getUiSessionTokenFromRequest(req)).toBeNull();
  });
});
