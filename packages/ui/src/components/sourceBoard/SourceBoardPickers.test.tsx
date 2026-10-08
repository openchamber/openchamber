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

// A status without a workspace list, before it loads or while Linear is not
// connected, once sent the team picker into React's "maximum update depth"
// loop and took the whole board down.
test('the team picker renders while the Linear status has no workspace list', async () => {
  const { I18nProvider } = await import('@/lib/i18n');
  const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
  const { createWebAPIs } = await import('../../../../web/src/api/index');
  const { useLinearAuthStore } = await import('@/stores/useLinearAuthStore');
  const { SourceBoardTeamPicker } = await import('./SourceBoardPickers');
  const apis = createWebAPIs();

  for (const status of [null, { connected: false }]) {
    useLinearAuthStore.setState({ status });
    await act(async () => {
      root.render(
        <I18nProvider>
          <RuntimeAPIContext.Provider value={apis}>
            <SourceBoardTeamPicker teams={[]} selectedTeamId={null} onSelectTeam={() => {}} onWorkspaceSwitched={() => {}} />
          </RuntimeAPIContext.Provider>
        </I18nProvider>,
      );
    });
    expect(host.textContent).toContain('All teams');
  }
});
