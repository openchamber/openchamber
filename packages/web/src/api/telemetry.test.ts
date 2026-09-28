import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createWebTelemetryAPI } from './telemetry';

const makeApi = (config?: { appKey: string; hostUrl: string }) => {
  const init = vi.fn();
  const capture = vi.fn();
  const api = createWebTelemetryAPI({ init, capture }, config ?? { appKey: 'test-app-key', hostUrl: 'https://eu.i.posthog.com' });
  return { api, init, capture };
};

// createWebTelemetryAPI only initializes under a browser-like globalThis.window;
// the vitest node environment has none, so the tests install a minimal stub.
let createdWindow = false;

describe('createWebTelemetryAPI', () => {
  beforeEach(() => {
    if (globalThis.window === undefined) {
      // SAFETY: the module under test only checks window for existence and
      // reads the desktop bridge off it; a bare object satisfies both.
      (globalThis as { window?: unknown }).window = {};
      createdWindow = true;
    }
  });

  afterEach(() => {
    // SAFETY: the same minimal window stub installed in beforeEach; only the
    // desktop bridge key and the stub itself are removed.
    const desktopWindow = globalThis.window as { __OPENCHAMBER_DESKTOP__?: unknown } | undefined;
    if (desktopWindow) delete desktopWindow.__OPENCHAMBER_DESKTOP__;
    if (createdWindow) {
      // SAFETY: removing the stub this test installed; production code never
      // relies on a window it did not create.
      delete (globalThis as { window?: unknown }).window;
      createdWindow = false;
    }
  });

  test('initializes PostHog lazily on the first event, not at creation', async () => {
    const { api, init, capture } = makeApi();
    expect(init).not.toHaveBeenCalled();
    api.trackEvent('test_event', { a: 1 });
    // capture runs on a microtask after the lazy init resolves.
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    expect(init).toHaveBeenCalledTimes(1);
    expect(init).toHaveBeenCalledWith('test-app-key', expect.objectContaining({
      ip: false,
      autocapture: false,
      capture_pageview: false,
      disable_session_recording: true,
      advanced_disable_decide: true,
    }));
    expect(capture).toHaveBeenCalledWith('test_event', { a: 1 });
  });

  test('reuses the initialization for later events', async () => {
    const { api, init, capture } = makeApi();
    api.trackEvent('first');
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(1));
    api.trackEvent('second', { b: 2 });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledTimes(2));
    expect(init).toHaveBeenCalledTimes(1);
  });

  test('delegates to the desktop bridge and never reaches PostHog', () => {
    const desktopTrack = vi.fn();
    // SAFETY: mirrors the Electron preload bridge shape the module checks for.
    (globalThis.window as { __OPENCHAMBER_DESKTOP__?: unknown }).__OPENCHAMBER_DESKTOP__ = { trackTelemetryEvent: desktopTrack };
    const { api, init, capture } = makeApi();
    api.trackEvent('bridged', { a: 1 });
    expect(desktopTrack).toHaveBeenCalledWith('bridged', { a: 1 });
    expect(init).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  test('does nothing without a configured app key', async () => {
    const { api, init, capture } = makeApi({ appKey: '', hostUrl: 'https://eu.i.posthog.com' });
    api.trackEvent('test_event');
    // Drain the microtask chain: initIfNeeded resolves null and capture never fires.
    await new Promise((resolve) => setImmediate(resolve));
    expect(init).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});