import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { GuestStatusView } from '@openchamber/sdk';

import { I18nProvider } from '@/lib/i18n';
import type { GuestStatusControlBinding } from '@/lib/guests/status-controls';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { GuestStatusViewBody } from './WorkStatusGuestView';

const viewWith = (checked: boolean): GuestStatusView => ({
  rows: [
    { kind: 'line', id: 'cpu', label: 'CPU', content: { kind: 'bar', value: 25, tone: 'info' }, value: '25%' },
    { kind: 'line', id: 'servers', label: 'Dev servers', content: { kind: 'chips', chips: [{ id: 'p5173', label: ':5173', url: 'http://localhost:5173' }] } },
    {
      kind: 'line', id: 'web', label: 'web', dot: 'success',
      actions: [
        { kind: 'button', id: 'stop-web', label: 'Stop', confirm: 'Stop web?' },
        { kind: 'switch', id: 'watch', label: 'Watch', checked },
      ],
    },
    { kind: 'note', id: 'hint', text: 'Compose file found.' },
  ],
  controls: [{ kind: 'button', id: 'refresh', label: 'Refresh' }],
});

const settle = async () => {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
};

test('draws the service view, posts actions with confirmation, and publishes header controls', async () => {
  const dom = new Window({ url: 'http://status.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element,
    Node: dom.Node, Event: dom.Event, MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    localStorage: dom.localStorage, PointerEvent: dom.PointerEvent, MouseEvent: dom.MouseEvent, HTMLInputElement: dom.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const previousResolver = getRuntimeUrlResolver();
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://status.test' });
  let watching = true;
  let releaseRefresh: () => void = () => undefined;
  const refreshAnswered = new Promise<void>((resolve) => { releaseRefresh = resolve; });
  const posts: string[] = [];
  const reads: string[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const target = String(input instanceof Request ? input.url : input);
    if (!target.includes('/api/guests/monitor/service/request')) return Response.json({});
    const request = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}')));
    if (request.method === 'POST') {
      if (JSON.parse(request.body).id === 'refresh') {
        await refreshAnswered;
        return Response.json({ status: 204, body: '' });
      }
      posts.push(request.body);
      if (JSON.parse(request.body).id === 'watch') watching = false;
      return Response.json({ status: 204, body: '' });
    }
    reads.push(`${request.query?.directory ?? ''} ${request.query?.locale ?? ''}`);
    return Response.json({ status: 200, body: JSON.stringify(viewWith(watching)) });
  });
  const bindings: Array<GuestStatusControlBinding | null> = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <I18nProvider>
        <GuestStatusViewBody
          guestId="monitor"
          source={{ path: '/status', interval: 60_000 }}
          directory="/repo"
          onStatusControls={(binding) => bindings.push(binding)}
        />
      </I18nProvider>,
    ));
    await settle();
    expect(reads).toEqual(['/repo en']);
    expect(container.textContent).toContain('CPU');
    expect(container.textContent).toContain(':5173');
    expect(container.textContent).toContain('Compose file found.');
    expect(container.querySelectorAll('iframe')).toHaveLength(0);
    expect(bindings.at(-1)?.controls).toEqual([{ kind: 'button', id: 'refresh', label: 'Refresh', disabled: false }]);

    // A header control is held while its request runs.
    const header = bindings.at(-1);
    if (!header) throw new Error('No header binding');
    await act(async () => header.dispatch({ id: 'refresh' }));
    expect(bindings.at(-1)?.controls[0]?.disabled).toBe(true);
    await act(async () => releaseRefresh());
    await settle();
    expect(bindings.at(-1)?.controls[0]?.disabled).toBe(false);

    const stop = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Stop');
    if (!stop) throw new Error('Stop did not render');
    await act(async () => stop.click());
    expect(stop.textContent).toBe('Stop web?');
    expect(posts).toEqual([]);
    await act(async () => stop.click());
    await settle();
    expect(posts).toEqual([JSON.stringify({ id: 'stop-web' })]);
    expect(reads.length).toBe(3);

    const watch = container.querySelector<HTMLElement>('[role="switch"]');
    if (!watch) throw new Error('Switch did not render');
    expect(watch.getAttribute('aria-checked')).toBe('true');
    await act(async () => watch.click());
    await settle();
    expect(posts.at(-1)).toBe(JSON.stringify({ id: 'watch', value: 'off' }));
    expect(watch.getAttribute('aria-checked')).toBe('false');
    expect(watch.hasAttribute('data-disabled')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    expect(bindings.at(-1)).toBeNull();
    fetch.mockRestore();
    setRuntimeUrlResolver(previousResolver);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('says when the service does not answer and keeps no iframe', async () => {
  const dom = new Window({ url: 'http://status.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, HTMLElement: dom.HTMLElement, Element: dom.Element,
    Node: dom.Node, Event: dom.Event, MutationObserver: dom.MutationObserver, getComputedStyle: dom.getComputedStyle.bind(dom),
    localStorage: dom.localStorage, PointerEvent: dom.PointerEvent, MouseEvent: dom.MouseEvent, HTMLInputElement: dom.HTMLInputElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const previousResolver = getRuntimeUrlResolver();
  configureRuntimeUrlResolver({ apiBaseUrl: 'http://status.test' });
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ error: 'SERVICE_FAILED', message: 'down' }, { status: 502 }));
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <I18nProvider>
        <GuestStatusViewBody guestId="monitor" source={{ path: '/status', interval: 60_000 }} directory={null} onStatusControls={() => undefined} />
      </I18nProvider>,
    ));
    await settle();
    expect(container.textContent).toContain("The extension's service didn't answer.");
  } finally {
    await act(async () => root.unmount());
    fetch.mockRestore();
    setRuntimeUrlResolver(previousResolver);
    await dom.happyDOM.close();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
