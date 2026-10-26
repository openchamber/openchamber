import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { RuntimeAPIs, TrackerAPI, TrackerAuthStatus, TrackerDescriptor } from '@/lib/api/types';
import { acmeTrackerDescriptor, linearLikeTrackerDescriptor } from '@/lib/trackers/descriptor.fixture';
import { useTrackerAuthStore } from '@/stores/useTrackerAuthStore';

const unexpected = (): never => { throw new Error('Unexpected runtime API access'); };

const connectedStatus: TrackerAuthStatus = {
  connected: true,
  account: { id: 'org-a', name: 'Acme Org', user: { name: 'Ada', avatarUrl: null }, current: true },
  accounts: [
    { id: 'org-a', name: 'Acme Org', user: { name: 'Ada', avatarUrl: null }, current: true },
    { id: 'org-b', name: 'Beta Org', user: { name: 'Ada B', avatarUrl: null }, current: false },
  ],
};

describe('TrackerSettings', () => {
  let dom: Window;
  let root: Root | undefined;
  let container: HTMLElement;
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const calls: string[] = [];
  let status: TrackerAuthStatus = { connected: false };
  let statusFailures = 0;
  let pollTick: (() => void) | null = null;

  const trackers: TrackerAPI = {
    providers: unexpected,
    authStatus: async (provider) => {
      calls.push(`status:${provider}`);
      if (statusFailures > 0) {
        statusFailures -= 1;
        throw new Error('offline');
      }
      return status;
    },
    authStart: async (provider, origin) => {
      calls.push(`start:${provider}:${origin}`);
      return { authorizationUrl: 'https://tracker.example/authorize', expiresIn: 600 };
    },
    authDisconnect: async (provider) => { calls.push(`disconnect:${provider}`); status = { connected: false }; return { removed: true }; },
    authActivate: async (provider, accountId) => { calls.push(`activate:${provider}:${accountId}`); return status; },
    mappingGet: async (provider) => {
      calls.push(`mapping:${provider}`);
      return { connected: true, defaultProjectPath: null, containers: [{ id: 'team-1', key: 'ENG', name: 'Engineering', projectPath: null }] };
    },
    preferencesGet: async (provider) => { calls.push(`preferences:${provider}`); return { sessionComments: false }; },
    list: unexpected, refreshListReads: unexpected, get: unexpected, states: unexpected, updateState: unexpected,
    mappingSet: unexpected, sessionStatusPost: unexpected, preferencesSet: unexpected,
  };
  const apis: RuntimeAPIs = {
    runtime: { platform: 'web', isVSCode: false, isDesktop: false }, trackers,
    get sourceControl() { return unexpected(); },
    get git() { return unexpected(); }, get terminal() { return unexpected(); },
    get files() { return unexpected(); },
    // `useDirectoryStore` writes the home directory once on import, debounced;
    // that write can land during any test, so settings saves are accepted.
    settings: { load: unexpected, save: async () => ({}) },
    get permissions() { return unexpected(); }, get notifications() { return unexpected(); },
  };

  beforeEach(() => {
    dom = new Window({ url: 'http://localhost/' });
    const values = {
      window: dom, document: dom.document, navigator: dom.navigator,
      localStorage: dom.localStorage, sessionStorage: dom.sessionStorage,
      HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
      HTMLInputElement: dom.HTMLInputElement, DocumentFragment: dom.DocumentFragment,
      MutationObserver: dom.MutationObserver, ResizeObserver: dom.ResizeObserver,
      MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent, Event: dom.Event,
      CustomEvent: dom.CustomEvent, getComputedStyle: dom.getComputedStyle.bind(dom),
      requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
      cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom), IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(values)) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, value });
    }
    // The browser sign-in is watched on an interval; the test runs each tick by hand.
    pollTick = null;
    Object.defineProperty(window, 'setInterval', {
      configurable: true,
      value: (callback: () => void, delay: number) => {
        if (delay === 1_500) pollTick = callback;
        return delay;
      },
    });
    Object.defineProperty(window, 'clearInterval', {
      configurable: true,
      value: (id: number) => { if (id === 1_500) pollTick = null; },
    });
    Object.defineProperty(window, 'open', { configurable: true, value: () => null });
    calls.length = 0;
    status = { connected: false };
    statusFailures = 0;
    useTrackerAuthStore.getState().resetForRuntimeSwitch();
    registerRuntimeAPIs(apis);
    container = document.createElement('div');
    document.body.append(container);
  });

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = undefined;
    registerRuntimeAPIs(null);
    useTrackerAuthStore.getState().resetForRuntimeSwitch();
    await dom.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  const mount = async (descriptor: TrackerDescriptor) => {
    const { createRoot } = await import('react-dom/client');
    const { TrackerSettings } = await import('./TrackerSettings');
    const { I18nProvider } = await import('@/lib/i18n');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => {
      mounted.render(<I18nProvider><TooltipProvider><TrackerSettings descriptor={descriptor} /></TooltipProvider></I18nProvider>);
    });
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-expanded]');
    if (!trigger) throw new Error('Missing tracker card trigger');
    await act(async () => { trigger.click(); });
  };

  const buttonLabels = () => [...container.querySelectorAll('button')].map((entry) => entry.textContent?.trim());

  const click = async (label: string) => {
    const button = [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
    if (!button || button.disabled) throw new Error(`Button unavailable: ${label}`);
    await act(async () => { button.click(); });
  };

  test('connects through the browser and stops waiting once the account appears', async () => {
    await mount(linearLikeTrackerDescriptor());
    expect(calls).toEqual(['status:linear']);
    expect(container.textContent).toContain('Linear');

    await click('Connect');
    expect(calls).toContain('start:linear:web');
    expect(container.textContent).toContain('Waiting');
    expect(pollTick).not.toBeNull();

    status = connectedStatus;
    await act(async () => { pollTick?.(); });
    expect(pollTick).toBeNull();
    expect(container.textContent).toContain('Acme Org');
    expect(buttonLabels()).toContain('Disconnect');
  });

  test('keeps waiting for the browser sign-in when the opening status read failed', async () => {
    statusFailures = 1;
    await mount(linearLikeTrackerDescriptor());
    await click('Connect');
    expect(pollTick).not.toBeNull();

    // The first poll is the first answer: the tracker is checked now, and still not connected.
    await act(async () => { pollTick?.(); });
    expect(pollTick).not.toBeNull();

    status = connectedStatus;
    await act(async () => { pollTick?.(); });
    expect(pollTick).toBeNull();
    expect(container.textContent).toContain('Acme Org');
  });

  test('switches to another account and offers another sign-in where the tracker keeps several', async () => {
    status = connectedStatus;
    await mount(linearLikeTrackerDescriptor());
    expect(container.textContent).toContain('Beta Org');
    expect(buttonLabels()).toContain('Add workspace');

    await click('Switch to');
    expect(calls).toContain('activate:linear:org-b');
  });

  test('shows neither other accounts nor a second sign-in for a tracker with one account', async () => {
    status = connectedStatus;
    const linear = linearLikeTrackerDescriptor();
    await mount(linearLikeTrackerDescriptor({ capabilities: { ...linear.capabilities, multipleAccounts: false } }));
    expect(container.textContent).not.toContain('Beta Org');
    expect(buttonLabels()).not.toContain('Add workspace');
    expect(buttonLabels()).not.toContain('Switch to');
  });

  test('reads project mapping and session comments only where the capabilities offer them', async () => {
    status = connectedStatus;
    await mount(linearLikeTrackerDescriptor());
    expect(calls).toContain('mapping:linear');
    expect(calls).toContain('preferences:linear');
    expect(container.querySelector('[data-settings-item="integrations.linear.mapping"]')).not.toBeNull();
    expect(container.querySelector('[data-settings-item="integrations.linear.session-comments"]')).not.toBeNull();

    await act(async () => { root?.unmount(); });
    calls.length = 0;
    useTrackerAuthStore.getState().resetForRuntimeSwitch();
    const linear = linearLikeTrackerDescriptor();
    await mount(linearLikeTrackerDescriptor({
      capabilities: { ...linear.capabilities, projectMapping: false, sessionComments: false },
    }));
    expect(calls).toEqual(['status:linear']);
  });

  test('disconnects the tracker it shows', async () => {
    status = connectedStatus;
    await mount(linearLikeTrackerDescriptor());
    await click('Disconnect');
    expect(calls).toContain('disconnect:linear');
    expect(buttonLabels()).toContain('Connect');
  });

  test('names a tracker without its own words by its served name and asks for an update when it cannot sign in here', async () => {
    await mount(acmeTrackerDescriptor());
    expect(calls).toEqual(['status:acme-tickets']);
    expect(container.textContent).toContain('Acme Tickets');
    expect(container.querySelector('[data-settings-item="integrations.acme-tickets"]')).not.toBeNull();
    expect(buttonLabels()).not.toContain('Connect');
    expect(container.textContent).toContain('Update OpenChamber');
  });
});
