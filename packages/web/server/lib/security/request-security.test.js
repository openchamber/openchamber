import { describe, expect, test } from 'bun:test';
import { createRequestSecurityRuntime } from './request-security.js';

const createRuntime = () => createRequestSecurityRuntime({
  readSettingsFromDiskMigrated: async () => ({}),
});

describe('request security runtime', () => {
  test('allows packaged client origins for remote client transports', async () => {
    const runtime = createRuntime();

    expect(await runtime.isRequestOriginAllowed({
      headers: {
        origin: 'openchamber-ui://app',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).toBe(true);

    expect(await runtime.isRequestOriginAllowed({
      headers: {
        origin: 'capacitor://localhost',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).toBe(true);

    // Android Capacitor WebView (androidScheme 'https') reports this origin.
    expect(await runtime.isRequestOriginAllowed({
      headers: {
        origin: 'https://localhost',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).toBe(true);
  });

  test('rejects unknown origins', async () => {
    const runtime = createRuntime();

    expect(await runtime.isRequestOriginAllowed({
      headers: {
        origin: 'https://evil.example.com',
        host: '192.168.1.130:1202',
      },
      socket: {},
    })).toBe(false);
  });

  test('allows the external host when TLS terminates before an HTTP proxy hop', async () => {
    const runtime = createRuntime();

    expect(await runtime.isRequestOriginAllowed({
      headers: {
        origin: 'https://devchamber.example.com',
        host: 'devchamber.example.com',
        'x-forwarded-proto': 'http',
      },
      socket: {},
    })).toBe(true);
  });

  test('uses the forwarded external host without trusting a different origin', async () => {
    const runtime = createRuntime();
    const request = {
      headers: {
        host: '127.0.0.1:3000',
        'x-forwarded-host': 'devchamber.example.com',
        'x-forwarded-proto': 'http',
      },
      socket: {},
    };

    expect(await runtime.isRequestOriginAllowed({
      ...request,
      headers: { ...request.headers, origin: 'https://devchamber.example.com' },
    })).toBe(true);
    expect(await runtime.isRequestOriginAllowed({
      ...request,
      headers: { ...request.headers, origin: 'https://evil.example.com' },
    })).toBe(false);
  });

  test('reads the slot for the request port when a browser shares jars across LAN ports', () => {
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

  test('never reads another port cookie when this port has none of its own', () => {
    const runtime = createRuntime();
    // Reaching :3001 with only the :3000 cookie in the jar must NOT borrow the
    // other instance's session — it stays unauthenticated for this port.
    const req = {
      headers: { host: '192.168.0.1:3001', cookie: 'oc_ui_session_3000=token-a' },
    };
    expect(runtime.getUiSessionTokenFromRequest(req)).toBeNull();
  });

  test('reads the bare cookie for a host without an explicit port', () => {
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
