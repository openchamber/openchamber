import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { createOpencodeClient, type AssistantMessage, type Session, type UserMessage } from '@opencode-ai/sdk/v2';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { getSyncPerformanceDiagnostics, resetSyncPerformanceDiagnostics, setSyncPerformanceDiagnosticsEnabled } from '@/sync/performance-diagnostics';
let WorkStatusTelemetrySection: typeof import('./WorkStatusTelemetrySection').WorkStatusTelemetrySection;

const directory = '/repo';
const sessionId = 'session-1';
const user: UserMessage = { id: 'user-1', sessionID: sessionId, role: 'user', time: { created: 1000 }, agent: 'build', model: { providerID: 'test', modelID: 'test' } };
const session: Session = { id: sessionId, slug: 'test', projectID: 'project', directory, title: 'test', version: '1', time: { created: 0, updated: 1 } };
let tokenReads = 0;
const assistant: AssistantMessage = {
  id: 'assistant-final', sessionID: sessionId, role: 'assistant', parentID: user.id,
  agent: 'build', mode: 'build', providerID: 'test', modelID: 'test', path: { cwd: directory, root: directory },
  time: { created: 2000, completed: 7000 }, cost: 0.01,
  get tokens() { tokenReads += 1; return { input: 100, output: 20, reasoning: 10, cache: { read: 40, write: 0 } }; },
};

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'HTMLIFrameElement', 'localStorage', 'getComputedStyle', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, HTMLIFrameElement: win.HTMLIFrameElement, localStorage: win.localStorage,
    getComputedStyle: win.getComputedStyle.bind(win), ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, restore: () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    void win.happyDOM.close();
  } };
};

describe('mounted turn telemetry with live sync stores', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let messageRequests = 0;
  // Keep bootstrap pending so each test controls real store publications. No
  // hook/module replacements: subscription and materialization paths are real.
  const sdk = createOpencodeClient({ baseUrl: 'http://telemetry.test', fetch: (request) => {
    const url = new URL(request instanceof Request ? request.url : request.toString());
    if (/\/session\/[^/]+\/message$/.test(url.pathname)) messageRequests += 1;
    return new Promise<Response>(() => undefined);
  } });
  const render = async (visible = true, selectedDirectory = directory, selectedSession = sessionId) => {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={selectedDirectory}>
        <I18nProvider>{visible ? <WorkStatusTelemetrySection sessionId={selectedSession} directory={selectedDirectory} /> : null}</I18nProvider>
      </SyncProvider>,
    ));
  };
  const store = (dir = directory) => {
    const result = getSyncChildStores().getChild(dir);
    if (!result) throw new Error('Expected mounted directory store');
    return result;
  };

  beforeEach(async () => {
    dom = installDom();
    ({ WorkStatusTelemetrySection } = await import('./WorkStatusTelemetrySection'));
    root = createRoot(dom.container);
    tokenReads = 0;
    messageRequests = 0;
    setSyncPerformanceDiagnosticsEnabled(true);
    useUIStore.setState({ workStatusExpandedSections: {}, workStatusHiddenSections: ['telemetry'], workStatusHiddenSectionsExplicit: false });
    await render();
    await act(async () => store().setState({ session: [session], message: { [sessionId]: [user, assistant] }, part: { [assistant.id]: [] }, session_status: {} }));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    setSyncPerformanceDiagnosticsEnabled(false);
    dom.restore();
  });

  test('waits for authority, then shows actual token values even when idle is omitted from the snapshot', async () => {
    expect(dom.container.textContent).toContain('Turn stats');
    expect(dom.container.textContent).not.toContain('Whole turn');
    await act(async () => store().setState({ sessionStatusReady: true }));
    expect(dom.container.textContent).toContain('~6 tok/s');
    expect(dom.container.textContent).toContain('100 ↑ · 30 ↓');
    const heading = dom.container.querySelector('button');
    if (!heading) throw new Error('Expected section heading');
    expect(heading.textContent).toBe('Turn stats');
    expect(heading.querySelectorAll('svg').length).toBe(2);
    expect(dom.container.querySelectorAll('svg').length).toBe(2);
    expect(tokenReads > 0).toBe(true);
    expect(messageRequests).toBe(0);
  });

  test('collapsed remount keeps a usable header and reopening reads fresh data', async () => {
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'idle' } } }));
    const button = dom.container.querySelector('button');
    if (!button) throw new Error('Expected collapse button');
    await act(async () => button.click());
    await render(false);
    await render();
    expect(dom.container.querySelector('button')?.getAttribute('aria-expanded')).toBe('false');
    expect(dom.container.textContent).toContain('Turn stats');
    expect(dom.container.textContent).not.toContain('Whole turn');
    const reopen = dom.container.querySelector('button');
    if (!reopen) throw new Error('Expected reopen button');
    await act(async () => reopen.click());
    expect(dom.container.textContent).toContain('~6 tok/s');
  });

  test('busy, retry and collapsed updates do not notify records subscribers or aggregate tokens', async () => {
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'idle' } } }));
    // Positive control: on idle, part replacement reaches the subscriber and calculator.
    tokenReads = 0;
    resetSyncPerformanceDiagnostics();
    await act(async () => store().setState({ part: { [assistant.id]: [] } }));
    expect(tokenReads > 0).toBe(true);
    expect((getSyncPerformanceDiagnostics()?.sessionMessageChangeCallbacks ?? 0) > 0).toBe(true);

    for (const mode of ['busy', 'retry', 'collapsed'] as const) {
      await act(async () => {
        store().setState({ session_status: { [sessionId]: mode === 'retry'
          ? { type: 'retry', attempt: 1, message: 'retry', next: 0 }
          : { type: mode === 'busy' ? 'busy' : 'idle' } } });
        useUIStore.getState().setWorkStatusSectionExpanded('telemetry', mode !== 'collapsed');
      });
      resetSyncPerformanceDiagnostics();
      tokenReads = 0;
      for (let i = 0; i < 100; i += 1) {
        await act(async () => store().setState({ part: { [assistant.id]: [{ id: 'text', sessionID: sessionId,
          messageID: assistant.id, type: 'text', text: String(i), time: { start: 2500 } }] } }));
      }
      expect(tokenReads).toBe(0);
      expect(getSyncPerformanceDiagnostics()?.sessionMessageChangeCallbacks).toBe(0);
      if (mode === 'collapsed') expect(dom.container.textContent).toBe('Turn stats');
      else expect(dom.container.textContent).toContain('~6 tok/s');
    }
  });

  test('session and directory changes cannot retain another scope, including equal IDs', async () => {
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'idle' } } }));
    expect(dom.container.textContent).toContain('~6 tok/s');
    await render(true, directory, 'another-session');
    expect(dom.container.textContent).not.toContain('~6 tok/s');
    await render(true, '/another-repo');
    await act(async () => store('/another-repo').setState({ session_status: { [sessionId]: { type: 'busy' } } }));
    expect(dom.container.textContent).not.toContain('~6 tok/s');
    await render(true, directory);
    expect(dom.container.textContent).toContain('~6 tok/s');
  });

  test('same-ID corrections, partial history and reverts replace rather than cache stale stats', async () => {
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'idle' } }, message: { [sessionId]: [assistant] } }));
    expect(dom.container.textContent).not.toContain('Whole turn');
    await act(async () => store().setState({ message: { [sessionId]: [user, assistant] } }));
    expect(dom.container.textContent).toContain('~6 tok/s');
    const corrected = { ...assistant, tokens: { ...assistant.tokens, output: 90 } };
    await act(async () => store().setState({ message: { [sessionId]: [user, corrected] } }));
    expect(dom.container.textContent).toContain('~20 tok/s');
    await act(async () => store().setState({ session: [{ ...session, revert: { messageID: user.id } }] }));
    expect(dom.container.textContent).not.toContain('~20 tok/s');
    await act(async () => store().setState({ session: [session] }));
    expect(dom.container.textContent).toContain('~20 tok/s');
    await act(async () => store().setState({ message: {} }));
    expect(dom.container.textContent).not.toContain('~20 tok/s');
  });

  test('runtime identity changes discard retained results even with equal directory and session IDs', async () => {
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'idle' } } }));
    await act(async () => store().setState({ session_status: { [sessionId]: { type: 'busy' } } }));
    expect(dom.container.textContent).toContain('~6 tok/s');
    Object.defineProperty(window, '__OPENCHAMBER_API_BASE_URL__', { value: 'https://second-runtime.test', configurable: true });
    await render();
    expect(dom.container.textContent).not.toContain('~6 tok/s');
  });

  test('the heading shows response speed only, never whole-turn speed as a fallback', async () => {
    await act(async () => store().setState({ sessionStatusReady: true, part: { [assistant.id]: [
      { id: 'text', type: 'text', sessionID: sessionId, messageID: assistant.id, text: 'Final reply', time: { start: 3000, end: 5000 } },
    ] } }));
    expect(dom.container.querySelector('button')?.textContent).toBe('Turn stats~10 tok/s');
    expect(dom.container.textContent).toContain('Response~10 tok/s');
    expect(dom.container.textContent).toContain('Whole turn~6 tok/s');
    await act(async () => store().setState({ part: { [assistant.id]: [] } }));
    expect(dom.container.querySelector('button')?.textContent).toBe('Turn stats');
    expect(dom.container.textContent).not.toContain('Response');
    expect(dom.container.textContent).toContain('Whole turn~6 tok/s');
  });

  test('every metric has a full-row focus target and hover waits 750ms', async () => {
    const earlier = { ...assistant, id: 'earlier', time: { created: 1100, completed: 1900 } };
    await act(async () => store().setState({ sessionStatusReady: true,
      message: { [sessionId]: [user, earlier, assistant] }, part: {
        earlier: [{ id: 'earlier-text', type: 'text', sessionID: sessionId, messageID: earlier.id, text: 'Earlier', time: { start: 1200, end: 1800 } }],
        [assistant.id]: [{ id: 'text', type: 'text', sessionID: sessionId, messageID: assistant.id, text: 'Final reply', time: { start: 3000, end: 5000 } }],
      },
    }));
    const triggers = dom.container.querySelectorAll<HTMLElement>('[data-slot="tooltip-trigger"]');
    expect(triggers.length).toBe(9);
    for (const trigger of triggers) expect(trigger.tabIndex).toBe(0);
    expect(dom.container.querySelectorAll('[title]').length).toBe(0);
    const response = triggers[0];
    await act(async () => {
      response.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      response.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
      response.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
      response.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 650));
    });
    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull();
    expect(response.hasAttribute('data-popup-open')).toBe(false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)); });
    expect(response.hasAttribute('data-popup-open')).toBe(true);
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain('How fast the final text arrived');
    expect(dom.container.querySelector('[data-slot="tooltip-content"]')).toBeNull();
  });

  test('keyboard focus exposes the cost explanation without adding an icon or native title', async () => {
    await act(async () => store().setState({ sessionStatusReady: true }));
    const triggers = dom.container.querySelectorAll<HTMLElement>('[data-slot="tooltip-trigger"]');
    const cost = triggers[triggers.length - 1];
    await act(async () => cost.focus());
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain('Cost reported by the provider');
    expect(cost.querySelector('svg')).toBeNull();
    expect(cost.hasAttribute('title')).toBe(false);
  });
});
