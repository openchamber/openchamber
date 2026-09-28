// Desktop-side telemetry consent. The shared UI gates events at their source
// (`packages/ui/src/lib/telemetry.ts`), but the desktop main process captures
// updater-lifecycle events without a renderer in the loop, so it re-derives the
// same predicate from the instance's persisted settings. Profile values live in
// preferences.json and win over the legacy settings.json copy (the settings
// split). Keep the consent semantics in sync with
// CURRENT_TELEMETRY_CONSENT_VERSION in the shared UI (currently 1).

export const isDesktopTelemetryDisabledByEnv = (env = process.env) => {
  return env.OPENCHAMBER_DISABLE_TELEMETRY === '1' || env.DO_NOT_TRACK === '1';
};

export const isDesktopTelemetryConsented = ({ settingsRoot, preferencesValues }) => {
  const merged = { ...settingsRoot, ...preferencesValues };
  return merged.reportUsage === true
    && Number.isInteger(merged.telemetryConsentVersion)
    && merged.telemetryConsentVersion >= 1;
};