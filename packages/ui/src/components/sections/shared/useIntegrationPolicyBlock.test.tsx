import { afterAll, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  Event: browser.Event, FocusEvent: browser.FocusEvent,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { opencodeClient } = await import('@/lib/opencode/client');
const { useIntegrationPolicyState } = await import('./useIntegrationPolicyBlock');

const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);
afterAll(async () => {
  await act(async () => root.unmount());
  browser.close();
});

let latest: ReturnType<typeof useIntegrationPolicyState> | null = null;
const Probe = ({ directory }: { directory: string | null }) => {
  latest = useIntegrationPolicyState(directory);
  return null;
};

test('a failed read for a new directory does not keep the previous project policies', async () => {
  const spy = spyOn(opencodeClient, 'getIntegrationPolicies').mockImplementation(async (directory) => {
    if (directory === '/project-a') return [{ resource: 'plugin:shared', effect: 'deny', path: null }];
    throw new Error('OpenCode is down');
  });

  await act(async () => root.render(<Probe directory="/project-a" />));
  await act(async () => { await Promise.resolve(); });
  expect(latest?.hasRead).toBe(true);
  expect(latest?.isBlocked('plugin:shared')).toBe(true);

  await act(async () => root.render(<Probe directory="/project-b" />));
  // The previous project's rule must not describe the new directory while its
  // read is pending, or after that read fails.
  expect(latest?.isBlocked('plugin:shared')).toBe(false);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(latest?.hasRead).toBe(false);
  expect(latest?.isBlocked('plugin:shared')).toBe(false);

  spy.mockRestore();
});
