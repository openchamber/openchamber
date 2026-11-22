import { afterEach, expect, spyOn, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Session } from '@/lib/opencode/model';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  SVGElement: browser.SVGElement, HTMLIFrameElement: browser.HTMLIFrameElement,
  DocumentFragment: browser.DocumentFragment, ShadowRoot: browser.ShadowRoot, NodeFilter: browser.NodeFilter,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent, PointerEvent: browser.PointerEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
const { act, Profiler } = await import('react');
const { createRoot } = await import('react-dom/client');
const { opencodeClient } = await import('@/lib/opencode/client');
spyOn(opencodeClient, 'getFilesystemHome').mockResolvedValue('/workspace');
spyOn(opencodeClient, 'getConfig').mockResolvedValue({});
spyOn(opencodeClient, 'listProjects').mockResolvedValue([]);
spyOn(opencodeClient, 'getLocation').mockResolvedValue({ directory: '/workspace', project: { id: 'p', directory: '/workspace', canonical: '/workspace' } });
spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ revision: 1, enabled: false, minutes: 30, sessions: [], data: [] }));
const { I18nProvider } = await import('@/lib/i18n');
const { withMultiRunMembership } = await import('@/lib/multirun/identity');
const { SyncProvider, useChildStoreManager } = await import('@/sync/sync-context');
const { useRunParentHint } = await import('./RunParentHint');
let root: Root | null = null;
afterEach(async () => { await act(async () => { root?.unmount(); }); root = null; document.body.innerHTML = ''; });

// Oracle: the hint is visible only for a bound parent role, and ordinary
// timestamp changes keep the primitive selector stable. A role change must
// redraw it, so the no-redraw assertion has a positive control.
test('explains parent guidance, ignores streamed timestamps, and disappears on detach', async () => {
  let manager: ReturnType<typeof useChildStoreManager> | undefined;
  const Probe = () => { manager = useChildStoreManager(); return null; };
  const HintProbe = () => {
    const row = useRunParentHint('parent', '/workspace');
    return <section data-has-parent-hint={row !== null}>{row}</section>;
  };
  const sdk = OpenCode.make({
    baseUrl: 'https://sync.test',
    fetch: async (request) => {
      const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
      return path.endsWith('/event')
        ? new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } })
        : Response.json({ data: [] });
    },
  });
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  let commits = 0;
  await act(async () => { root?.render(<I18nProvider><SyncProvider sdk={sdk} directory="">
    <Probe /><Profiler id="parent-hint" onRender={() => { commits += 1; }}><HintProbe /></Profiler>
  </SyncProvider></I18nProvider>); });
  if (!manager) throw new Error('Directory manager missing');
  const store = manager.ensureChild('/workspace', { bootstrap: false });
  const session: Session = {
    id: 'parent', projectID: 'project', directory: '/workspace', title: 'Run parent', cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 },
    metadata: withMultiRunMembership({}, { version: 1, sessionID: 'parent', group: { kind: 'id', id: '9f512893-6e63-4e49-a534-5de733ca103e' }, groupSlug: 'run', role: 'parent', providerID: 'p', modelID: 'm' }),
  };
  expect(document.body.textContent).not.toContain('Parent conversation');
  expect(host.querySelector('section')?.getAttribute('data-has-parent-hint')).toBe('false');
  const beforeRole = commits;
  await act(async () => { store.setState({ session: [session] }); });
  expect(commits).toBeGreaterThan(beforeRole);
  expect(document.body.textContent).toContain('Parent conversation');
  const afterRole = commits;
  await act(async () => { store.setState({ session: [{ ...session, time: { ...session.time, updated: 2 } }] }); });
  expect(commits).toBe(afterRole);
  const info = document.querySelector<HTMLButtonElement>('button[aria-label="More information"]');
  if (!info) throw new Error('Guidance explanation unavailable');
  await act(async () => { info.click(); });
  expect(document.body.textContent).toContain('Open an individual session to steer its work');
  await act(async () => { store.setState({ session: [{ ...session, metadata: { openchamber: { multirunDetached: true } } }] }); });
  expect(document.body.textContent).not.toContain('Parent conversation');
});
