import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
// The picker's imports pull in app stores that load on import; none of that
// matters here, so their requests never answer.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

// A status without an account list, before it loads or while the tracker is
// not connected, once sent the team picker into React's "maximum update
// depth" loop and took the whole board down.
test('the container picker renders while the tracker status has no account list', async () => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { useTrackerAuthStore } = await import('@/stores/useTrackerAuthStore');
  const { useTrackerRegistry } = await import('@/lib/trackers/registry');
  const { linearLikeTrackerDescriptor } = await import('@/lib/trackers/descriptor.fixture');
  const { SourceBoardContainerPicker } = await import('./SourceBoardPickers');
  const apis = createWebAPIs();
  const linear = linearLikeTrackerDescriptor();
  useTrackerRegistry.setState({ ordered: [linear], byId: new Map([[linear.id, linear]]), status: 'ready', holdsList: true });

  for (const status of [null, { connected: false as const }]) {
    useTrackerAuthStore.setState({ entries: { linear: { status, isLoading: false, hasChecked: status !== null } } });
    await act(async () => {
      root.render(
        <I18nProvider>
          <RuntimeAPIContext.Provider value={apis}>
            <SourceBoardContainerPicker provider="linear" containers={[]} selectedContainerId={null} onSelectContainer={() => {}} onAccountSwitched={() => {}} />
          </RuntimeAPIContext.Provider>
        </I18nProvider>,
      );
    });
    expect(host.textContent).toContain('All teams');
  }
});

test('the repository picker names the chosen repository, or all of them', async () => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { SourceBoardRepositoryPicker } = await import('./SourceBoardPickers');
  const repositories = ['/work/app', '/work/team/api'];

  for (const sheet of [false, true]) {
    for (const [selected, shown] of [['/work/team/api', 'team/api'], [null, 'All repositories']] as const) {
      await act(async () => {
        root.render(
          <I18nProvider>
            <SourceBoardRepositoryPicker repositories={repositories} selected={selected} root="/work" allAvailable onSelect={() => {}} sheet={sheet} />
          </I18nProvider>,
        );
      });
      expect(host.textContent).toContain(shown);
      expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Repository');
    }
  }
});
