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
});
