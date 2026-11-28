import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { RuntimeAPIs, TrackerListOptions } from '@/lib/api/types';
import type { ReferenceBrowser } from './useReferenceBrowser';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
  HTMLInputElement: browser.HTMLInputElement, SVGElement: browser.SVGElement,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const PROVIDER = 'ext-jira';
const SAVED = [{ id: 'f-1', name: 'My queue' }, { id: 'f-2', name: 'Reported by me' }];

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const flush = async () => {
  for (let i = 0; i < 12; i += 1) await act(async () => { await Promise.resolve(); });
};

const renders: ReferenceBrowser[] = [];
const current = (): ReferenceBrowser | undefined => renders.at(-1);

const show = async (capabilities = { saved: true, people: true, priority: true }) => {
  const [{ useReferenceBrowser }, { I18nProvider }, { RuntimeAPIContext }, { createWebAPIs }, { useTrackerRegistry }, { useTrackerAuthStore }, { linearLikeTrackerDescriptor }] = await Promise.all([
    import('./useReferenceBrowser'),
    import('@/lib/i18n'),
    import('@/contexts/runtimeAPIContext'),
    import('../../../../web/src/api/index'),
    import('@/lib/trackers/registry'),
    import('@/stores/useTrackerAuthStore'),
    import('@/lib/trackers/descriptor.fixture'),
  ]);
  const base = linearLikeTrackerDescriptor();
  const descriptor = {
    ...base,
    id: PROVIDER,
    name: 'Jira',
    stateFilters: ['open', 'all', 'done'],
    capabilities: { ...base.capabilities, filters: capabilities },
  };
  const registry = { ordered: [descriptor], byId: new Map([[descriptor.id, descriptor]]), status: 'ready' as const, holdsList: true };
  useTrackerRegistry.setState(registry);
  Object.assign(useTrackerRegistry.getInitialState(), registry);
  useTrackerAuthStore.setState({
    entries: { [PROVIDER]: { status: { connected: true, account: { id: 'u-1', name: 'Mona', current: true }, accounts: [] }, isLoading: false, hasChecked: true } },
  });

  const baseAPIs = createWebAPIs();
  const trackers = baseAPIs.trackers;
  if (!trackers) throw new Error('the web APIs serve trackers');
  const reads: TrackerListOptions[] = [];
  const apis: RuntimeAPIs = {
    ...baseAPIs,
    trackers: {
      ...trackers,
      savedFilters: async () => ({ connected: true, filters: SAVED }),
      list: async (_provider, options) => {
        reads.push(options ?? {});
        return { connected: true, items: [], cursor: null, hasMore: false };
      },
    },
  };

  const Harness: React.FC = () => {
    renders.push(useReferenceBrowser({ source: `tracker:${PROVIDER}`, directory: null, isMobile: false }));
    return null;
  };

  renders.length = 0;
  await act(async () => {
    root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}><Harness /></RuntimeAPIContext.Provider>
      </I18nProvider>,
    );
  });
  await flush();
  return reads;
};

describe('tracker saved filters', () => {
  test('offers the filters the provider lists and sends the chosen one, remembering it for the tracker', async () => {
    const reads = await show();
    expect(current()?.savedFilters).toEqual(SAVED);
    expect(current()?.trackerFilter.saved).toBe('');
    expect(reads.at(-1)?.savedFilter).toBeUndefined();

    await act(async () => { current()?.selectTrackerFilter({ saved: 'f-1' }); });
    await flush();
    expect(current()?.trackerFilter.saved).toBe('f-1');
    expect(reads.at(-1)?.savedFilter).toBe('f-1');

    await act(async () => root.unmount());
    root = createRoot(host);
    await show();
    expect(current()?.trackerFilter.saved).toBe('f-1');
  });

  test('a tracker without the capability neither reads nor keeps a saved filter', async () => {
    const reads = await show({ saved: false, people: true, priority: true });
    expect(current()?.savedFilters).toEqual([]);
    expect(current()?.trackerFilter.saved).toBe('');
    expect(reads.every((options) => options.savedFilter === undefined)).toBe(true);
  });
});
