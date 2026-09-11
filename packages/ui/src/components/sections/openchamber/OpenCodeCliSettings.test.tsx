import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { I18nProvider } from '@/lib/i18n';
import type { SettingsWriteResult } from '@/lib/persistence';

// React DOM detects input-event support when imported, so install the DOM
// first and import react-dom/client dynamically (same pattern as ArchiveView).
const windowInstance = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: windowInstance,
  document: windowInstance.document,
  navigator: windowInstance.navigator,
  Node: windowInstance.Node,
  Element: windowInstance.Element,
  HTMLElement: windowInstance.HTMLElement,
  HTMLInputElement: windowInstance.HTMLInputElement,
  Event: windowInstance.Event,
  MouseEvent: windowInstance.MouseEvent,
  MutationObserver: windowInstance.MutationObserver,
  getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
  requestAnimationFrame: windowInstance.requestAnimationFrame.bind(windowInstance),
  cancelAnimationFrame: windowInstance.cancelAnimationFrame.bind(windowInstance),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const updateCalls: Array<{ opencodeBinary?: string; opencodeRuntime?: 'stable' | 'beta' }> = [];
let updateResult: SettingsWriteResult = { ok: true, written: true };
const updateDesktopSettings = async (changes: { opencodeBinary?: string; opencodeRuntime?: 'stable' | 'beta' }) => {
  updateCalls.push(changes);
  return updateResult;
};
let holdLoad = false;
let loadResolver: (() => void) | null = null;
const loadDesktopSettings = () =>
  new Promise<{ opencodeBinary: string; opencodeRuntime: 'stable' }>((resolve) => {
    if (holdLoad) {
      loadResolver = () => resolve({ opencodeBinary: '', opencodeRuntime: 'stable' });
    } else {
      resolve({ opencodeBinary: '', opencodeRuntime: 'stable' });
    }
  });
const deferredRestartCalls: Array<['cli', { id: string }]> = [];
const recordDeferredOpenCodeRestart = (...args: ['cli', { id: string }]) => {
  deferredRestartCalls.push(args);
};
const uiState = {
  showOpenCodeUpdateNotifications: false,
  setShowOpenCodeUpdateNotifications: () => undefined,
};

mock.module('@/lib/desktop', () => ({
  isDesktopShell: () => false,
  requestFileAccess: async () => ({ success: false }),
}));
mock.module('@/lib/persistence', () => ({ loadDesktopSettings, updateDesktopSettings }));
mock.module('@/lib/opencode/deferredRestart', () => ({ recordDeferredOpenCodeRestart }));
mock.module('@/lib/platform', () => ({ isWindowsArm64: () => false }));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: <T,>(selector: (state: typeof uiState) => T): T => selector(uiState),
}));
mock.module('@/components/ui', () => ({
  toast: { success: () => undefined, error: () => undefined },
}));

const { createRoot } = await import('react-dom/client');

const { OpenCodeCliSettings } = await import('./OpenCodeCliSettings');

describe('OpenCodeCliSettings', () => {
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    updateCalls.length = 0;
    updateResult = { ok: true, written: true };
    deferredRestartCalls.length = 0;
    holdLoad = false;
    loadResolver = null;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
  });

  // The deferred-restart marker is recorded after the save promise settles, so
  // a test that asserts markers must let those microtasks run first.
  const flushMicrotasks = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  test('defaults to the Stable runtime selection', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <OpenCodeCliSettings />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const options = Array.from(host.querySelectorAll<HTMLElement>('[role="button"]'))
      .filter((option) => option.textContent?.includes('Stable') || option.textContent?.includes('Beta'));
    const stableOption = options.find((option) => option.textContent?.includes('Stable'));
    const betaOption = options.find((option) => option.textContent?.includes('Beta'));
    if (!stableOption || !betaOption) {
      throw new Error('expected Stable and Beta runtime options');
    }

    // The settings document defaults to stable, so the Stable option is the
    // selected one and no persistence write happens on mount.
    expect(stableOption.getAttribute('aria-pressed')).toBe('true');
    expect(betaOption.getAttribute('aria-pressed')).toBe('false');
    expect(updateCalls.length).toBe(0);
    expect(deferredRestartCalls.length).toBe(0);
  });

  test('persists a runtime selection and records its deferred restart', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <OpenCodeCliSettings />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const betaOption = Array.from(host.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((option) => option.textContent?.includes('Beta'));
    if (!betaOption) {
      throw new Error('expected Beta runtime option');
    }

    await act(async () => {
      betaOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(updateCalls.at(-1)).toEqual({ opencodeRuntime: 'beta' });
    expect(deferredRestartCalls.at(-1)).toEqual(['cli', { id: 'opencode-runtime' }]);
  });

  test('selecting Stable persists it and records the deferred restart', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <OpenCodeCliSettings />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const options = Array.from(host.querySelectorAll<HTMLElement>('[role="button"]'))
      .filter((option) => option.textContent?.includes('Stable') || option.textContent?.includes('Beta'));
    const betaOption = options.find((option) => option.textContent?.includes('Beta'));
    const stableOption = options.find((option) => option.textContent?.includes('Stable'));
    if (!betaOption || !stableOption) {
      throw new Error('expected Stable and Beta runtime options');
    }

    // The load settles on Stable, so move to Beta first: re-clicking the
    // already-selected option is a no-op by contract.
    await act(async () => {
      betaOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      stableOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    expect(updateCalls.at(-1)).toEqual({ opencodeRuntime: 'stable' });
    expect(deferredRestartCalls.at(-1)).toEqual(['cli', { id: 'opencode-runtime' }]);
  });

  test('a failed runtime save records no restart marker', async () => {
    updateResult = { ok: false };
    await act(async () => {
      root.render(
        <I18nProvider>
          <OpenCodeCliSettings />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const betaOption = Array.from(host.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((option) => option.textContent?.includes('Beta'));
    if (!betaOption) {
      throw new Error('expected Beta runtime option');
    }

    await act(async () => {
      betaOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    // The write failed, so the selection must not pretend a restart is pending.
    expect(updateCalls.at(-1)).toEqual({ opencodeRuntime: 'beta' });
    expect(deferredRestartCalls.length).toBe(0);
  });

  test('a redundant runtime write records no restart marker', async () => {
    updateResult = { ok: true, written: false };
    await act(async () => {
      root.render(
        <I18nProvider>
          <OpenCodeCliSettings />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const betaOption = Array.from(host.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((option) => option.textContent?.includes('Beta'));
    if (!betaOption) {
      throw new Error('expected Beta runtime option');
    }

    await act(async () => {
      betaOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();

    // The revert inside the debounce window cancelled the write as redundant:
    // nothing reached the server, so no restart marker is recorded.
    expect(updateCalls.at(-1)).toEqual({ opencodeRuntime: 'beta' });
    expect(deferredRestartCalls.length).toBe(0);
  });

  test('option click during load does not persist', async () => {
    holdLoad = true;
    await act(async () => {
      root.render(
        <I18nProvider>
          <OpenCodeCliSettings />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const betaOption = Array.from(host.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((option) => option.textContent?.includes('Beta'));
    if (!betaOption) {
      throw new Error('expected Beta runtime option');
    }

    // The load is still pending, so the option is disabled: the click handler
    // no-ops and nothing is persisted or marked for restart.
    expect(betaOption.getAttribute('aria-disabled')).toBe('true');
    await act(async () => {
      betaOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(updateCalls.length).toBe(0);
    expect(deferredRestartCalls.length).toBe(0);

    // Once the load resolves, the UI settles on the loaded value (stable).
    await act(async () => {
      loadResolver?.();
      await Promise.resolve();
    });
    const stableOption = Array.from(host.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((option) => option.textContent?.includes('Stable'));
    if (!stableOption) {
      throw new Error('expected Stable runtime option');
    }
    expect(stableOption.getAttribute('aria-pressed')).toBe('true');
    expect(betaOption.getAttribute('aria-pressed')).toBe('false');
    expect(updateCalls.length).toBe(0);
    expect(deferredRestartCalls.length).toBe(0);
  });

  test('re-clicking the selected option records no restart marker', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <OpenCodeCliSettings />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const betaOption = Array.from(host.querySelectorAll<HTMLElement>('[role="button"]'))
      .find((option) => option.textContent?.includes('Beta'));
    if (!betaOption) {
      throw new Error('expected Beta runtime option');
    }

    await act(async () => {
      betaOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();
    expect(updateCalls.length).toBe(1);
    expect(deferredRestartCalls.length).toBe(1);

    // Beta is still selected; clicking it again must not persist or mark a restart.
    await act(async () => {
      betaOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flushMicrotasks();
    expect(updateCalls.length).toBe(1);
    expect(deferredRestartCalls.length).toBe(1);
  });

  test('saving the binary path persists only the binary and marks the binary restart', async () => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <OpenCodeCliSettings />
        </I18nProvider>,
      );
      await Promise.resolve();
    });

    const input = host.querySelector<HTMLInputElement>('input[placeholder="/Users/you/.bun/bin/opencode"]');
    if (!input) {
      throw new Error('expected binary path input');
    }
    const setValue = Object.getOwnPropertyDescriptor(windowInstance.HTMLInputElement.prototype, 'value')?.set;
    if (!setValue) {
      throw new Error('input value setter missing');
    }
    await act(async () => {
      setValue.call(input, '/custom/opencode');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveButton = Array.from(host.querySelectorAll<HTMLElement>('button'))
      .find((button) => button.textContent?.includes('Save Changes'));
    if (!saveButton) {
      throw new Error('expected save button');
    }
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    // The binary-path save is independent of the runtime selection: it must
    // persist only the binary and record the binary restart marker.
    expect(updateCalls.at(-1)).toEqual({ opencodeBinary: '/custom/opencode' });
    expect(deferredRestartCalls.at(-1)).toEqual(['cli', { id: 'opencode-binary' }]);
  });
});
