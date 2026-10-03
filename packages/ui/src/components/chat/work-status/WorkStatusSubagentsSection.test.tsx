import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { useSessionActivityTimingStore } from '@/sync/session-activity-timing';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import type { State } from '@/sync/types';
import type { FormRequest, PermissionRequest, Session } from '@/lib/opencode/model';

let WorkStatusSubagentsSection: typeof import('./WorkStatusSubagentsSection').WorkStatusSubagentsSection;
const directory = '/subagent-test';
const parent: Session = { id: 'parent', projectID: 'project', directory, title: 'Parent', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 1 } };
const child: Session = { ...parent, id: 'child', parentID: parent.id, title: 'Child', cost: 0.25 };

const childForm: FormRequest = { id: 'form', sessionID: 'child', title: 'Question', fields: [{ key: 'answer', type: 'string' }] };

describe('subagent status rows', () => {
  let win: Window;
  let root: Root;
  let container: HTMLElement;
  let restoreGlobals: () => void;
  const sdk = OpenCode.make({ baseUrl: 'http://subagents.test', fetch: () => new Promise<Response>(() => undefined) });
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
  // The row's button is stretched under its content, so the icon and text
  // live in the row element around it.
  const rowContent = () => row().parentElement ?? row();
  const icon = () => rowContent().querySelector('use')?.getAttribute('href');
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
    expect(rowContent().textContent).toBe('Child$0.25');
    expect(row().getAttribute('aria-label')).toContain('is working');
    await publish({ session_status: { child: { type: 'retry', attempt: 1, message: 'Retrying', next: 100 } } });
    expect(icon()).toBe('#oc-record-circle');
    expect(container.textContent).toContain('1/1');
    await publish({ session_status: { child: { type: 'idle' } } });
    expect(icon()).toBe('#oc-checkbox-circle');
    expect(rowContent().textContent).toBe('Child$0.25');
    expect(row().getAttribute('aria-label')).toContain('Done');
  });

  test('marks a subagent whose last turn failed instead of calling it done', async () => {
    await publish({ sessionStatusReady: true, session_status: { child: { type: 'idle' } } });
    expect(icon()).toBe('#oc-checkbox-circle');
    await act(async () => useGlobalSessionStatusStore.setState({
      observedById: new Map([['child', { directory, outcome: 'failed' }]]),
    }));
    expect(icon()).toBe('#oc-close-circle');
    expect(row().getAttribute('aria-label')).toContain('Failed');
  });

  test('keeps permission and question blockers ahead of the running timer', async () => {
    await act(async () => useSessionActivityTimingStore.setState({ startedAt: new Map([['child', Date.now() - 83000]]) }));
    await publish({
      session_status: { child: { type: 'busy' } },
      // SAFETY: fixtures carry only the fields the section reads (their presence per session).
      permission: { child: [{ id: 'permission', sessionID: 'child', action: 'bash', resources: ['*'], metadata: {} } as PermissionRequest] },
      form: { child: [childForm] },
    });
    expect(icon()).toBe('#oc-alert');
    expect(rowContent().textContent).toContain('needs permission');
    expect(rowContent().querySelector('span[title]')).toBeNull();
    await publish({ permission: {} });
    expect(icon()).toBe('#oc-alert');
    expect(rowContent().textContent).toContain('asked a question');
    expect(rowContent().querySelector('span[title]')).toBeNull();
    await publish({ form: {} });
    expect(icon()).toBe('#oc-record-circle');
    expect(rowContent().querySelector('span[title]')).not.toBeNull();
  });

  test('orders rows newest first by creation and sinks finished ones', async () => {
    const older: Session = { ...child, id: 'older', title: 'Older', time: { created: 2, updated: 50 } };
    const newer: Session = { ...child, id: 'newer', title: 'Newer', time: { created: 3, updated: 10 } };
    const titles = () => Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-label]'))
      .map((button) => button.parentElement?.textContent?.replace(/\$.*$/, ''));
    await publish({
      session: [parent, older, newer],
      sessionStatusReady: true,
      session_status: { older: { type: 'busy' }, newer: { type: 'busy' } },
    });
    // Later activity on the older row does not lift it above the newer one.
    expect(titles()).toEqual(['Newer', 'Older']);
    await publish({ session_status: { older: { type: 'busy' }, newer: { type: 'idle' } } });
    expect(titles()).toEqual(['Older', 'Newer']);
    await publish({ session_status: { older: { type: 'idle' }, newer: { type: 'idle' } } });
    expect(titles()).toEqual(['Newer', 'Older']);
  });

  test('shows an observed current-turn duration only while running and expanded', async () => {
    await publish({ session_status: { child: { type: 'busy' } } });
    expect(rowContent().querySelector('span[title]')).toBeNull();
    await act(async () => useSessionActivityTimingStore.setState({ startedAt: new Map([['child', Date.now() - 83000]]) }));
    expect(/^1m 2[34]s$/.test(rowContent().querySelector('span[title]')?.textContent ?? '')).toBe(true);
    await act(async () => useUIStore.getState().setWorkStatusSectionExpanded('subagents', false));
    expect(container.querySelector('span[title]')).toBeNull();
    await act(async () => useUIStore.getState().setWorkStatusSectionExpanded('subagents', true));
    expect(rowContent().querySelector('span[title]')).not.toBeNull();
    await publish({ session_status: { child: { type: 'idle' } } });
    expect(rowContent().querySelector('span[title]')).toBeNull();
  });
});
