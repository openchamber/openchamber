import { describe, expect, test } from 'bun:test';
import { getRuntimeKey, isTransientRuntimeKey, resetRuntimeEndpointForTesting } from './runtime-switch';

// Same-origin web pages are served by the instance itself: no API base URL is
// injected, so the runtime key must fall back to the page origin. Without the
// fallback the key is the transient `url:default` and per-instance consumers
// (once-per-instance quota load, scoped theme entry, per-instance UI state)
// silently skip their work — usage stayed missing from the work-status panel
// until Settings -> Usage forced a fetch.
//
// Runs in its own file with an explicit reset: the endpoint-switching tests in
// runtime-switch.test.ts leave `activeRuntimeKey` behind, and bun:test shares
// module state across test files in a run.

interface FakeLocation {
  protocol: string;
  origin: string;
}

const withBrowserWindow = (
  location: FakeLocation | null,
  injected: Record<string, string> = {},
  run: () => void,
): void => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    if (location === null) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      const runtimeWindow: Record<string, unknown> = { location };
      for (const [key, value] of Object.entries(injected)) {
        runtimeWindow[key] = value;
      }
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: runtimeWindow,
      });
    }
    run();
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, 'window');
    }
  }
};

describe('getRuntimeKey same-origin browser fallback', () => {
  test('derives a non-transient key from the page origin when no API base URL is injected', () => {
    resetRuntimeEndpointForTesting();
    withBrowserWindow(
      { protocol: 'https:', origin: 'https://openchamber.example' },
      undefined,
      () => {
        const key = getRuntimeKey();
        expect(key).toBe('url:https://openchamber.example');
        expect(isTransientRuntimeKey(key)).toBe(false);
      },
    );
  });

  test('treats the page as local when the injected local origin matches it', () => {
    resetRuntimeEndpointForTesting();
    withBrowserWindow(
      { protocol: 'https:', origin: 'https://openchamber.example' },
      { __OPENCHAMBER_LOCAL_ORIGIN__: 'https://openchamber.example' },
      () => {
        expect(getRuntimeKey()).toBe('local');
      },
    );
  });

  test('keeps an injected API base URL ahead of the page origin', () => {
    resetRuntimeEndpointForTesting();
    withBrowserWindow(
      { protocol: 'https:', origin: 'https://openchamber.example' },
      { __OPENCHAMBER_API_BASE_URL__: 'https://api.example' },
      () => {
        const key = getRuntimeKey();
        expect(key).toBe('url:https://api.example');
        expect(isTransientRuntimeKey(key)).toBe(false);
      },
    );
  });

  test('stays transient on non-http(s) pages', () => {
    resetRuntimeEndpointForTesting();
    withBrowserWindow({ protocol: 'file:', origin: 'null' }, undefined, () => {
      const key = getRuntimeKey();
      expect(key).toBe('url:default');
      expect(isTransientRuntimeKey(key)).toBe(true);
    });
  });

  test('stays transient outside the browser', () => {
    resetRuntimeEndpointForTesting();
    withBrowserWindow(null, undefined, () => {
      const key = getRuntimeKey();
      expect(key).toBe('url:default');
      expect(isTransientRuntimeKey(key)).toBe(true);
    });
  });
});
