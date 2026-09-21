import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createOpencodeClient, type Session } from '@opencode-ai/sdk/v2';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useSessionActivityTimingStore } from '@/sync/session-activity-timing';
import type { State } from '@/sync/types';

let WorkStatusSubagentsSection: typeof import('./WorkStatusSubagentsSection').WorkStatusSubagentsSection;
const directory = '/subagent-test';
const parent: Session = { id: 'parent', slug: 'test', projectID: 'project', directory, title: 'Parent', version: '1', time: { created: 1, updated: 1 } };
const child: Session = { ...parent, id: 'child', parentID: parent.id, title: 'Child', cost: 0.25 };

describe('subagent status rows', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;
  const sdk = createOpencodeClient({ baseUrl: 'http://subagents.test', fetch: () => new Promise<Response>(() => undefined) });
  const render = async () => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider><WorkStatusSubagentsSection sessionId={parent.id} directory={directory} /></I18nProvider>
      </SyncProvider>,
    ));
  };
  const publish = async (patch: Partial<State>) => {
    const store = getSyncChildStores().getChild(directory);
    if (!store) throw new Error('Expected directory store');
    await act(async () => store.setState(patch));
  };
  const row = () => {
    const button = container.querySelector<HTMLButtonElement>('button[aria-label]');
    if (!button) throw new Error('Expected subagent row');
    return button;
  };
  const icon = () => row().querySelector('use')?.getAttribute('href');
  beforeEach(async () => {
    win = new Window({ url: 'http://localhost' });
    const values = {
      window: win, document: win.document, navigator: win.navigator,
      Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
      HTMLIFrameElement: win.HTMLIFrameElement, localStorage: win.localStorage,
      getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
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
    ({ WorkStatusSubagentsSection } = await import('./WorkStatusSubagentsSection'));
    useUIStore.setState({ workStatusExpandedSections: {} });
    useSessionActivityTimingStore.setState({ startedAt: new Map(), settledMs: new Map() });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await render();
    await publish({ session: [parent, child], session_status: {}, sessionStatusReady: false });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await win.happyDOM.close();
    restoreGlobals();
  });

  test('distinguishes unknown, running, retrying and settled status with Tasks icons', async () => {
    expect(icon()).toBe('#oc-time');
    await publish({ sessionStatusReady: true });
    expect(icon()).toBe('#oc-checkbox-circle');
    await publish({ session_status: { child: { type: 'busy' } } });
    expect(icon()).toBe('#oc-record-circle');
    expect(row().textContent).toBe('Child$0.25');
    expect(row().getAttribute('aria-label')).toContain('is working');
    await publish({ session_status: { child: { type: 'retry', attempt: 1, message: 'Retrying', next: 100 } } });
    expect(icon()).toBe('#oc-record-circle');
    expect(container.textContent).toContain('1/1');
    await publish({ session_status: { child: { type: 'idle' } } });
    expect(icon()).toBe('#oc-checkbox-circle');
    expect(row().textContent).toBe('Child$0.25');
    expect(row().getAttribute('aria-label')).toContain('Done');
  });

  test('keeps permission and question blockers ahead of the running timer', async () => {
    await act(async () => useSessionActivityTimingStore.setState({ startedAt: new Map([['child', Date.now() - 83000]]) }));
    await publish({
      session_status: { child: { type: 'busy' } },
      permission: { child: [{ id: 'permission', sessionID: 'child', permission: 'bash', patterns: ['*'], metadata: {}, always: [] }] },
      question: { child: [{ id: 'question', sessionID: 'child', questions: [] }] },
    });
    expect(icon()).toBe('#oc-alert');
    expect(row().textContent).toContain('needs permission');
    expect(row().querySelector('span[title]')).toBeNull();
    await publish({ permission: {} });
    expect(icon()).toBe('#oc-alert');
    expect(row().textContent).toContain('asked a question');
    expect(row().querySelector('span[title]')).toBeNull();
    await publish({ question: {} });
    expect(icon()).toBe('#oc-record-circle');
    expect(row().querySelector('span[title]')).not.toBeNull();
  });

  test('shows an observed current-turn duration only while running and expanded', async () => {
    await publish({ session_status: { child: { type: 'busy' } } });
    expect(row().querySelector('span[title]')).toBeNull();
    await act(async () => useSessionActivityTimingStore.setState({ startedAt: new Map([['child', Date.now() - 83000]]) }));
    expect(/^1m 2[34]s$/.test(row().querySelector('span[title]')?.textContent ?? '')).toBe(true);
    await act(async () => useUIStore.getState().setWorkStatusSectionExpanded('subagents', false));
    expect(container.querySelector('span[title]')).toBeNull();
    await act(async () => useUIStore.getState().setWorkStatusSectionExpanded('subagents', true));
    expect(row().querySelector('span[title]')).not.toBeNull();
    await publish({ session_status: { child: { type: 'idle' } } });
    expect(row().querySelector('span[title]')).toBeNull();
  });
});
