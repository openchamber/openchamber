import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { toast } from 'sonner';
import type { Session } from '@/lib/opencode/model';
import type { LinkedIssue } from '@/lib/linkedIssues';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import * as sessionActions from '@/sync/session-actions';

let WorkStatusContextSection: typeof import('./WorkStatusContextSection').WorkStatusContextSection;

const directory = '/unlink-test';
const sessionId = 'session-unlink';
const githubIssue: LinkedIssue = {
  id: 'acme/app#12', number: 12, title: 'Rail badge count', url: 'https://github.com/acme/app/issues/12',
  kind: 'issue', author: 'someone', linkedAt: 1,
};
const linearIssue: LinkedIssue = {
  id: 'linear:ENG-7', kind: 'tracker', provider: 'linear', identifier: 'ENG-7', title: 'Broken login', url: 'https://linear.app/acme/issue/ENG-7',
  linkedAt: 2,
};
const sessionWith = (linked: LinkedIssue[]): Session => ({
  id: sessionId, projectID: 'project', directory, title: 'Unlink', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
  metadata: { openchamber: { linked_issues: linked } },
});

describe('agent-linked threads in the context section', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;
  let fetchSpy: ReturnType<typeof spyOn>;
  const sdk = OpenCode.make({ baseUrl: 'http://unlink.test', fetch: () => new Promise<Response>(() => undefined) });
  const render = async () => {
    await act(async () => root.render(
      <I18nProvider>
        <SyncProvider sdk={sdk} directory={directory}>
          <WorkStatusContextSection sessionId={sessionId} directory={directory} />
        </SyncProvider>
      </I18nProvider>,
    ));
  };
  const publish = async (linked: LinkedIssue[]) => {
    const store = getSyncChildStores().getChild(directory);
    if (!store) throw new Error('Expected directory store');
    await act(async () => store.setState({ session: [sessionWith(linked)] }));
  };
  const unlinkButtons = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove link"]'));

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLButtonElement: win.HTMLButtonElement, HTMLIFrameElement: win.HTMLIFrameElement,
      localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
      ResizeObserver: win.ResizeObserver, MutationObserver: win.MutationObserver,
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
    restoreGlobals = () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    };
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const target = String(input instanceof Request ? input.url : input);
      if (target.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
      if (target.includes('/session-knowledge/summary')) return Response.json({ notes: [], plans: [], memory: { global: 0, project: 0 } });
      if (target.includes('/config/skills')) return Response.json({ skills: [] });
      return Response.json({ data: [], cursor: {} });
    });
    ({ WorkStatusContextSection } = await import('./WorkStatusContextSection'));
    useUIStore.setState({ workStatusExpandedSections: { 'context-sources': true } });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
    await publish([githubIssue, linearIssue]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('offers a remove control on every linked row that unlinks the thread', async () => {
    expect(container.textContent).toContain('Rail badge count');
    expect(container.textContent).toContain('Broken login');
    const buttons = unlinkButtons();
    expect(buttons.length).toBe(2);

    const unlink = spyOn(sessionActions, 'setLinkedIssue').mockResolvedValue(sessionWith([]));
    await act(async () => { buttons[0].click(); });
    expect(unlink.mock.calls.length).toBe(1);
    expect(unlink.mock.calls[0]?.[0]).toBe(sessionId);
    expect(unlink.mock.calls[0]?.[1]).toBe(directory);
    expect(unlink.mock.calls[0]?.[2]).toMatchObject({ id: 'acme/app#12' });
    expect(unlink.mock.calls[0]?.[3]).toBe(false);
    unlink.mockRestore();
  });

  test('reports a failed unlink instead of silently keeping the link', async () => {
    const unlink = spyOn(sessionActions, 'setLinkedIssue').mockRejectedValue(new Error('metadata request failed'));
    const reported = spyOn(toast, 'error');
    await act(async () => { unlinkButtons()[0]?.click(); });
    expect(unlink.mock.calls.length).toBe(1);
    expect(reported.mock.calls.length).toBe(1);
    expect(reported.mock.calls[0]?.[0]).toBe('Could not remove the link');
    reported.mockRestore();
    unlink.mockRestore();
  });
});
