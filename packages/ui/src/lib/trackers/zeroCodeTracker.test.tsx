import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { TrackerAPI, TrackerDescriptor, TrackerItemSummary } from './types';
import { useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import { linearLikeTrackerDescriptor } from './descriptor.fixture';
import { createTrackerUrlMatcher } from './matchTrackerUrl';
import { useTrackerRegistry } from './registry';

/**
 * A tracker no UI code names: the server serves `plane`, and the picker, the
 * board's scope picker and the settings card name it and pick its features
 * from that descriptor alone, with the generic mark and the generic
 * sentences: nothing it shows names Linear.
 */

const GENERIC_MARK = 'use[href="#oc-record-circle"]';
const LINEAR_MARK = 'use[href="#oc-linear"]';

const plane: TrackerDescriptor = linearLikeTrackerDescriptor({
  id: 'plane',
  name: 'Plane',
  authMethods: ['token'],
  urlPatterns: [{ host: 'app.plane.so', path: '^/[^/]+/browse/([A-Za-z][A-Za-z0-9]*-\\d+)(?:/|$)' }],
});

const unexpected = (): never => { throw new Error('Unexpected runtime API access'); };

const statusReads: string[] = [];
const trackers: TrackerAPI = {
  providers: async () => [plane],
  authStatus: async (provider) => { statusReads.push(provider); return { connected: false }; },
  authStart: unexpected, authDisconnect: unexpected, authActivate: unexpected, list: unexpected,
  refreshListReads: unexpected, get: unexpected, states: unexpected, updateState: unexpected,
  mappingGet: unexpected, mappingSet: unexpected, sessionStatusPost: unexpected,
  preferencesGet: unexpected, preferencesSet: unexpected,
};
const apis: RuntimeAPIs = {
  runtime: { platform: 'web', isVSCode: false, isDesktop: false }, trackers,
  get sourceControl() { return unexpected(); },
  get git() { return unexpected(); }, get terminal() { return unexpected(); },
  get files() { return unexpected(); }, get settings() { return unexpected(); },
  get permissions() { return unexpected(); }, get notifications() { return unexpected(); },
};

const item: TrackerItemSummary = {
  provider: 'plane',
  id: 'uuid-3',
  identifier: 'PLN-3',
  title: 'Sync cycles to the board',
  url: 'https://app.plane.so/acme/browse/PLN-3/',
  state: { id: 'state-1', name: 'Todo', category: 'todo' },
  labels: [{ id: 'label-1', name: 'backend', color: '#22aa66' }],
};

describe('a tracker no UI code names', () => {
  let dom: Window;
  let root: Root | undefined;
  let container: HTMLElement;
  const globals = new Map<string, PropertyDescriptor | undefined>();
  const registryBefore = useTrackerRegistry.getState();

  beforeEach(async () => {
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
      // App stores that load on import never get an answer.
      fetch: () => new Promise<Response>(() => {}),
    };
    for (const [key, value] of Object.entries(values)) {
      globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    }
    statusReads.length = 0;
    useTrackerAuthStore.getState().resetForRuntimeSwitch();
    registerRuntimeAPIs(apis);
    container = document.createElement('div');
    document.body.append(container);
    // The real path: the registry asks the server for its trackers.
    await useTrackerRegistry.getState().refresh(trackers);
  });

  afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    root = undefined;
    registerRuntimeAPIs(null);
    useTrackerAuthStore.getState().resetForRuntimeSwitch();
    useTrackerRegistry.setState({
      runtimeKey: registryBefore.runtimeKey, byId: registryBefore.byId, ordered: registryBefore.ordered, status: registryBefore.status, holdsList: registryBefore.holdsList,
    });
    await dom.happyDOM.close();
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    globals.clear();
  });

  const render = async (node: React.ReactNode) => {
    const { createRoot } = await import('react-dom/client');
    const { I18nProvider } = await import('@/lib/i18n');
    const { TooltipProvider } = await import('@/components/ui/tooltip');
    const mounted = createRoot(container);
    root = mounted;
    await act(async () => { mounted.render(<I18nProvider><TooltipProvider>{node}</TooltipProvider></I18nProvider>); });
  };

  test('the registry holds the served tracker and reads its links', () => {
    const state = useTrackerRegistry.getState();
    expect(state.status).toBe('ready');
    expect(state.ordered.map((descriptor) => descriptor.name)).toEqual(['Plane']);
    expect(createTrackerUrlMatcher(state.ordered)(item.url)).toMatchObject({ provider: 'plane', identifier: 'PLN-3' });
  });

  test('a picker row shows its item with the features its descriptor serves', async () => {
    const { ReferencePickerRow } = await import('@/components/references/ReferencePickerRow');
    await render(
      <ReferencePickerRow
        item={{ source: 'tracker', provider: 'plane', item }}
        pullStatus={null}
        highlighted={false}
        checked={null}
        diffIncluded={false}
        now={Date.now()}
        onHighlight={() => {}}
        onToggle={() => {}}
        onActivate={() => {}}
      />,
    );
    expect(container.textContent).toContain('PLN-3');
    expect(container.textContent).toContain('Sync cycles to the board');
    // Labels show because Plane's served capabilities offer them; an unknown id would not.
    expect(container.textContent).toContain('backend');
    expect(container.textContent).not.toContain('Linear');
  });

  // The board's tracker tab is built inline in `SourceBoardView` (label
  // `descriptor.name`, icon `trackerPresentation(id).icon`) and is not
  // reachable without the whole board; its scope picker is the board surface
  // rendered here, and it draws the same mark.
  test('the board scope picker draws the generic mark', async () => {
    const { SourceBoardContainerPicker } = await import('@/components/sourceBoard/SourceBoardPickers');
    const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
    await render(
      <RuntimeAPIContext.Provider value={apis}>
        <SourceBoardContainerPicker
          provider="plane"
          containers={[{ id: 'project-1', key: 'PLN', name: 'Platform' }]}
          selectedContainerId="project-1"
          onSelectContainer={() => {}}
          onAccountSwitched={() => {}}
        />
      </RuntimeAPIContext.Provider>,
    );
    expect(container.textContent).toContain('Platform');
    expect(container.innerHTML).not.toContain('Linear');
    expect(container.querySelector(GENERIC_MARK)).not.toBeNull();
    expect(container.querySelector(LINEAR_MARK)).toBeNull();
  });

  test('the settings card names it Plane and draws the generic mark', async () => {
    const { TrackerSettings } = await import('@/components/sections/integrations/TrackerSettings');
    await render(<TrackerSettings descriptor={plane} />);
    expect(statusReads).toEqual(['plane']);
    expect(container.textContent).toContain('Connect Plane on this OpenChamber server.');
    expect(container.innerHTML).not.toContain('Linear');
    expect(container.querySelector('[data-settings-item="integrations.plane"]')).not.toBeNull();
    expect(container.querySelector(GENERIC_MARK)).not.toBeNull();
    expect(container.querySelector(LINEAR_MARK)).toBeNull();
  });
});
