import { describe, expect, test } from 'bun:test';
import { createRequestSecurityRuntime } from './request-security.js';

const createRuntime = (overrides = {}) => createRequestSecurityRuntime({
  readSettingsFromDiskMigrated: async () => ({}),
  ...overrides,
});

describe('request security runtime', () => {
  test('reads only the configured UI session cookie name', () => {
    const runtime = createRuntime({
      uiSessionCookieName: 'oc_ui_session_3000',
    });

    expect(runtime.getUiSessionTokenFromRequest({
      headers: { cookie: 'oc_ui_session_3000=session-token' },
    })).toBe('session-token');

    expect(runtime.getUiSessionTokenFromRequest({
      headers: { cookie: 'oc_ui_session=default-token' },
    })).toBeNull();
  });

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
});
