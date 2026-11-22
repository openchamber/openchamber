import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Part, Session } from '@/lib/opencode/model';
import type { State } from '@/sync/types';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { opencodeClient } from '@/lib/opencode/client';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

let WorkStatusPinnedSection: typeof import('./WorkStatusPinnedSection').WorkStatusPinnedSection;

const directory = '/pinned-test';
const sessionWith = (id: string, created: number | undefined, pins: Array<{ id: string; createdAt: number }>, parentID?: string): Session => ({
  id,
  parentID,
  projectID: 'project',
  directory,
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created, updated: created } as Session['time'],
  metadata: {
    openchamber: {
      context_obligatory_messages: pins.map((entry) => ({ ...entry, role: 'user' as const })),
    },
  },
});

const textPart = (sessionID: string, messageID: string, text: string): Part[] => [{
  id: `${messageID}_text`, sessionID, messageID, type: 'text', text,
} as Part];

describe('pinned messages stay scoped to the displayed session', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;
  let fetchSpy: ReturnType<typeof spyOn>;
  const sdk = OpenCode.make({ baseUrl: 'http://pinned.test', fetch: () => new Promise<Response>(() => undefined) });

  const render = async (sessionId: string) => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider><WorkStatusPinnedSection sessionId={sessionId} directory={directory} /></I18nProvider>
      </SyncProvider>,
    ));
  };
  const publish = async (patch: Partial<State>) => {
    const store = getSyncChildStores().getChild(directory);
    if (!store) throw new Error('Expected directory store');
    await act(async () => store.setState(patch));
  };

  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLButtonElement: win.HTMLButtonElement, localStorage: win.localStorage,
      getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
      MutationObserver: win.MutationObserver, requestAnimationFrame: win.requestAnimationFrame.bind(win),
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
      if (target.includes('/api/session-warming')) return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
      if (target.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
      return Response.json({ data: [], cursor: {} });
    });
    ({ WorkStatusPinnedSection } = await import('./WorkStatusPinnedSection'));
    useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [], entityById: new Map() });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    spyOn(opencodeClient, 'getSessionMessage').mockRestore();
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('a child renders only its own loaded pin and count', async () => {
    const child = sessionWith('ses_child', 100, [{ id: 'msg_parent', createdAt: 10 }, { id: 'msg_child', createdAt: 110 }], 'ses_parent');
    await render(child.id);
    await publish({
      session: [child],
      part: { msg_parent: textPart('ses_parent', 'msg_parent', 'Parent pin'), msg_child: textPart(child.id, 'msg_child', 'Child pin') },
    });

    expect(container.textContent).toContain('Child pin');
    expect(container.textContent).not.toContain('Parent pin');
    expect(container.querySelectorAll('button[aria-label="Go to message"]').length).toBe(1);
  });

  test('an unresolved own pin shows a neutral label, then its loaded text', async () => {
    const session = sessionWith('ses_top', 1, [{ id: 'msg_pending', createdAt: 10 }]);
    let resolveMessage!: (value: { info: never; parts: Part[] }) => void;
    const pending = new Promise<{ info: never; parts: Part[] }>((resolve) => { resolveMessage = resolve; });
    spyOn(opencodeClient, 'getSessionMessage').mockReturnValue(pending);
    await render(session.id);
    await publish({ session: [session], part: {} });

    expect(container.textContent).toContain('Pinned message');
    expect(container.textContent).not.toContain(session.id);

    await act(async () => resolveMessage({ info: {} as never, parts: textPart(session.id, 'msg_pending', 'Loaded pin text') }));
    expect(container.textContent).toContain('Loaded pin text');
    expect(container.textContent).not.toContain(session.id);
  });

  test('a missing own message keeps the neutral label and is read only from the displayed session', async () => {
    const session = sessionWith('ses_top', 1, [{ id: 'msg_gone', createdAt: 10 }]);
    const messageSpy = spyOn(opencodeClient, 'getSessionMessage').mockRejectedValue(new Error('not found'));
    await render(session.id);
    await publish({ session: [session], part: {} });

    expect(container.textContent).toContain('Pinned message');
    expect(container.textContent).not.toContain(session.id);
    expect(messageSpy.mock.calls.some((call) => call[1] === 'msg_gone')).toBe(true);
    expect(messageSpy.mock.calls.every((call) => call[0] === session.id)).toBe(true);
  });

  test('a fetched result whose text part belongs to another session or message is not shown', async () => {
    const session = sessionWith('ses_top', 1, [{ id: 'msg_own', createdAt: 10 }]);
    spyOn(opencodeClient, 'getSessionMessage').mockResolvedValue({
      info: {} as never,
      parts: [...textPart('ses_parent', 'msg_own', 'Parent text'), ...textPart(session.id, 'msg_other', 'Other message text')],
    });
    await render(session.id);
    await publish({ session: [session], part: {} });

    expect(container.textContent).toContain('Pinned message');
    expect(container.textContent).not.toContain('Parent text');
    expect(container.textContent).not.toContain('Other message text');
  });

  test('an available message label preserves its session reference verbatim', async () => {
    const session = sessionWith('ses_e80c83bb1ffecbp9ZwWXhL0ruD', 1, [{ id: 'msg_reference', createdAt: 10 }]);
    await render(session.id);
    await publish({
      session: [session],
      part: { msg_reference: textPart(session.id, 'msg_reference', `${session.id} also done. this is crazy`) },
    });

    expect(container.textContent).toContain(`${session.id} also done. this is crazy`);
  });

  test('the global session record covers a directory snapshot that has not arrived', async () => {
    const session = sessionWith('ses_top', 1, [{ id: 'msg_global', createdAt: 10 }]);
    spyOn(opencodeClient, 'getSessionMessage').mockResolvedValue({
      info: {} as never,
      parts: textPart(session.id, 'msg_global', 'Global pin text'),
    });
    await render(session.id);
    await publish({ session: [], part: {} });
    await act(async () => useGlobalSessionsStore.getState().upsertSession(session));

    expect(container.textContent).toContain('Global pin text');
  });
});
