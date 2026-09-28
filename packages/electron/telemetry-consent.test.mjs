import assert from 'node:assert/strict';
import test from 'node:test';

import { isDesktopTelemetryConsented, isDesktopTelemetryDisabledByEnv } from './telemetry-consent.mjs';

test('env kill-switches disable desktop telemetry', () => {
  assert.equal(isDesktopTelemetryDisabledByEnv({ OPENCHAMBER_DISABLE_TELEMETRY: '1' }), true);
  assert.equal(isDesktopTelemetryDisabledByEnv({ DO_NOT_TRACK: '1' }), true);
  assert.equal(isDesktopTelemetryDisabledByEnv({ OPENCHAMBER_DISABLE_TELEMETRY: '0', DO_NOT_TRACK: '' }), false);
  assert.equal(isDesktopTelemetryDisabledByEnv({}), false);
});

const consented = (overrides = {}) => isDesktopTelemetryConsented({
  settingsRoot: {},
  preferencesValues: { reportUsage: true, telemetryConsentVersion: 1, ...overrides },
});

test('consent requires the prompt answered and usage reporting on', () => {
  assert.equal(consented(), true);
  assert.equal(consented({ telemetryConsentVersion: 0 }), false);
  assert.equal(consented({ reportUsage: false }), false);
  // A newer consent copy version stays valid.
  assert.equal(consented({ telemetryConsentVersion: 2 }), true);
});

test('consent without an explicit record is declined', () => {
  assert.equal(isDesktopTelemetryConsented({ settingsRoot: {}, preferencesValues: {} }), false);
  assert.equal(isDesktopTelemetryConsented({ settingsRoot: {}, preferencesValues: { reportUsage: true } }), false);
  assert.equal(isDesktopTelemetryConsented({ settingsRoot: {}, preferencesValues: { reportUsage: true, telemetryConsentVersion: '1' } }), false);
  assert.equal(isDesktopTelemetryConsented({ settingsRoot: {}, preferencesValues: { reportUsage: true, telemetryConsentVersion: 1.5 } }), false);
});

test('preferences.json wins over the legacy settings.json copy', () => {
  // Installs predating the settings split keep profile values in settings.json;
  // when both files carry the key, preferences.json is the current truth.
  assert.equal(isDesktopTelemetryConsented({
    settingsRoot: { reportUsage: true, telemetryConsentVersion: 1 },
    preferencesValues: { reportUsage: false, telemetryConsentVersion: 1 },
  }), false);
  assert.equal(isDesktopTelemetryConsented({
    settingsRoot: { reportUsage: false },
    preferencesValues: { reportUsage: true, telemetryConsentVersion: 1 },
  }), true);
  // Legacy installs whose settings.json already carries the answer.
  assert.equal(isDesktopTelemetryConsented({
    settingsRoot: { reportUsage: true, telemetryConsentVersion: 1 },
    preferencesValues: {},
  }), true);
});