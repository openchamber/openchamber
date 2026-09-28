import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import {
  isTelemetryDisabledByEnv,
  getTelemetryChannel,
  getTelemetryConnection,
  getTelemetryAppVersion,
  getTelemetrySurface,
  getTelemetryOS,
  CURRENT_TELEMETRY_CONSENT_VERSION,
  setTelemetryConsentState,
  trackTelemetryEvent,
} from './telemetry';
import { getRegisteredRuntimeAPIs, registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { TelemetryAPI } from '@/lib/api/types';

describe('telemetry utilities', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENCHAMBER_DISABLE_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    delete process.env.VITE_DISABLE_TELEMETRY;
    delete process.env.OPENCHAMBER_CHANNEL;
    delete process.env.VITE_OPENCHAMBER_CHANNEL;
    delete process.env.APP_VERSION;
    delete process.env.VITE_APP_VERSION;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('isTelemetryDisabledByEnv returns true when OPENCHAMBER_DISABLE_TELEMETRY=1', () => {
    process.env.OPENCHAMBER_DISABLE_TELEMETRY = '1';
    expect(isTelemetryDisabledByEnv()).toBe(true);
  });

  test('isTelemetryDisabledByEnv returns true when DO_NOT_TRACK=1', () => {
    process.env.DO_NOT_TRACK = '1';
    expect(isTelemetryDisabledByEnv()).toBe(true);
  });

  test('isTelemetryDisabledByEnv returns false when no disable flags are set', () => {
    expect(isTelemetryDisabledByEnv()).toBe(false);
  });

  test('getTelemetryChannel resolves beta channel correctly from version or env', () => {
    process.env.OPENCHAMBER_CHANNEL = 'beta';
    expect(getTelemetryChannel()).toBe('beta');

    process.env.OPENCHAMBER_CHANNEL = '';
    process.env.APP_VERSION = '1.2.3-beta.1';
    expect(getTelemetryChannel()).toBe('beta');
  });

  test('getTelemetryChannel resolves stable channel by default', () => {
    expect(getTelemetryChannel()).toBe('stable');
  });

  test('getTelemetryConnection returns local in Node/test environment', () => {
    expect(getTelemetryConnection()).toBe('local');
  });

  test('CURRENT_TELEMETRY_CONSENT_VERSION is a positive integer', () => {
    expect(CURRENT_TELEMETRY_CONSENT_VERSION).toBeGreaterThan(0);
  });

  test('getTelemetryAppVersion resolves app version from env', () => {
    process.env.VITE_APP_VERSION = '2.4.1';
    expect(getTelemetryAppVersion()).toBe('2.4.1');
  });

  test('getTelemetrySurface and getTelemetryOS resolve defaults', () => {
    expect(getTelemetrySurface()).toBe('web');
    expect(['macOS', 'Linux', 'Windows', 'unknown']).toContain(getTelemetryOS());
  });
});

describe('trackTelemetryEvent consent gate', () => {
  const originalApis = getRegisteredRuntimeAPIs();
  const tracked: string[] = [];

  beforeEach(() => {
    tracked.length = 0;
    // SAFETY: this test registers only the telemetry slot the gate reads; the
    // registry's other required slots stay unset and unobserved.
    const registerTestApis = registerRuntimeAPIs as (apis: { telemetry?: TelemetryAPI } | null) => void;
    registerTestApis({
      telemetry: { trackEvent: (name: string) => tracked.push(name) },
    });
    setTelemetryConsentState({ reportUsage: true, consentVersion: CURRENT_TELEMETRY_CONSENT_VERSION });
    delete process.env.OPENCHAMBER_DISABLE_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
    delete process.env.VITE_DISABLE_TELEMETRY;
  });

  afterEach(() => {
    registerRuntimeAPIs(originalApis);
    // Restore the module default: consent absent until a push arrives.
    setTelemetryConsentState({ reportUsage: false, consentVersion: 0 });
  });

  test('tracks after the consent prompt is answered and usage reporting is on', () => {
    trackTelemetryEvent('test_event');
    expect(tracked).toEqual(['test_event']);
  });

  test('does not track before the consent prompt is answered', () => {
    setTelemetryConsentState({ reportUsage: true, consentVersion: 0 });
    trackTelemetryEvent('test_event');
    expect(tracked).toEqual([]);
  });

  test('does not track when usage reporting is off', () => {
    setTelemetryConsentState({ reportUsage: false, consentVersion: CURRENT_TELEMETRY_CONSENT_VERSION });
    trackTelemetryEvent('test_event');
    expect(tracked).toEqual([]);
  });

  test('does not track without any consent push', () => {
    setTelemetryConsentState({ reportUsage: false, consentVersion: 0 });
    trackTelemetryEvent('test_event');
    expect(tracked).toEqual([]);
  });

  test('env kill-switch wins over consent', () => {
    process.env.OPENCHAMBER_DISABLE_TELEMETRY = '1';
    trackTelemetryEvent('test_event');
    expect(tracked).toEqual([]);
  });
});
