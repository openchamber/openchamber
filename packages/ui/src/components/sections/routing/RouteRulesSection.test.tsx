import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'Event',
  'KeyboardEvent',
  'PointerEvent',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT', 'CustomEvent', 'MutationObserver'] as const;

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLInputElement: happyWindow.HTMLInputElement,
    Event: happyWindow.Event,
    KeyboardEvent: happyWindow.KeyboardEvent,
    PointerEvent: happyWindow.PointerEvent,
    localStorage: happyWindow.localStorage,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  
    CustomEvent: happyWindow.CustomEvent,
    MutationObserver: happyWindow.MutationObserver,};
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

const rule = {
  id: 'rule_1',
  action: 'avoid',
  providers: ['anthropic'],
  models: [],
  fixed: true,
  until: 1893575040000,
  text: "don't use anthropic today",
  summary: 'Avoid anthropic',
  source: 'interpreter',
  createdAt: 1,
  origin: { key: 'anthropic', option: 'Anthropic provider only' },
};

type Sent = { url: string; method: string; body: string };

const sent: Sent[] = [];
let respond: (request: Sent) => Response = () => new Response('', { status: 500 });

const reply = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

let mounted: { root: Root; restore: () => void } | null = null;

const settle = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

// Fields that save on change need the native setter, so React's tracked value does not hide the change.
const changeValue = async (input: HTMLInputElement, value: string) => {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setValue?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const buttonWith = (container: HTMLElement, text: string): HTMLButtonElement => {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((el) => el.textContent?.trim() === text);
  if (!button) throw new Error(`no button "${text}"`);
  return button;
};

const inputNamed = (container: HTMLElement, label: string): HTMLInputElement => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`no input labelled "${label}"`);
  return input;
};

const renderSection = async () => {
  const dom = installDom();
  // Imported after the DOM exists: react-dom decides at load time whether input events are native.
  const { createRoot } = await import('react-dom/client');
  const { RouteRulesSection } = await import('./RouteRulesSection');
  const { I18nProvider } = await import('@/lib/i18n');
  const root = createRoot(dom.container);
  mounted = { root, restore: dom.restore };
  await act(async () => {
    root.render(
      <I18nProvider>
        <RouteRulesSection />
      </I18nProvider>,
    );
  });
  await settle();
  return dom.container;
};

describe('RouteRulesSection', () => {
  beforeEach(() => {
    sent.length = 0;
    spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request: Sent = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? String(init.body) : '' };
      sent.push(request);
      return respond(request);
    });
    respond = (request) => {
      if (request.url === '/api/model-routes/rules' && request.method === 'GET') return reply(JSON.stringify({ rules: [rule] }));
      if (request.url === `/api/model-routes/rules/${rule.id}` && request.method === 'DELETE') return reply(JSON.stringify({ rules: [] }));
      return new Response('', { status: 404 });
    };
  });

  afterEach(async () => {
    mock.restore();
    if (!mounted) return;
    const current = mounted;
    mounted = null;
    await act(async () => current.root.unmount());
    current.restore();
  });

  test('applying a sentence posts it for interpretation and shows what changed', async () => {
    respond = (request) => {
      if (request.url === '/api/model-routes/rules' && request.method === 'GET') return reply(JSON.stringify({ rules: [] }));
      if (request.url === '/api/model-routes/interpret') {
        return reply(JSON.stringify({ status: 'applied', stage: 'keywords', confidence: 'certain', summary: 'Avoid anthropic', rules: [rule] }));
      }
      return new Response('', { status: 404 });
    };
    const container = await renderSection();
    await changeValue(inputNamed(container, 'Route by sentence'), "don't use anthropic today");
    await act(async () => buttonWith(container, 'Apply').click());
    await settle();
    const posted = sent.find((request) => request.url === '/api/model-routes/interpret');
    expect(posted?.method).toBe('POST');
    expect(JSON.parse(posted?.body ?? '')).toMatchObject({ text: "don't use anthropic today" });
    expect(container.textContent).toContain('Applied: Avoid anthropic');
  });

  test('undoing an applied rule removes it on the server and clears the list', async () => {
    const container = await renderSection();
    expect(container.textContent).toContain('Avoid anthropic');
    await act(async () => buttonWith(container, 'Undo').click());
    await settle();
    expect(sent.filter((request) => request.method === 'DELETE')).toEqual([
      { url: `/api/model-routes/rules/${rule.id}`, method: 'DELETE', body: '' },
    ]);
    expect(container.textContent).not.toContain('Avoid anthropic');
  });
});
