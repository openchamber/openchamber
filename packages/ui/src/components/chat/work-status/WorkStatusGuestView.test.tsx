import { expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { GuestRequest, GuestStatusView } from '@openchamber/sdk';

import { toast } from '@/components/ui/toast';
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

const holdResponse = () => {
  let resolve: (response: Response) => void = () => undefined;
  const promise = new Promise<Response>((answer) => { resolve = answer; });
  return { promise, resolve };
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
  let refreshAnswer = holdResponse();
  const posts: Array<Pick<GuestRequest, 'body' | 'query'>> = [];
  const reads: Array<GuestRequest['query']> = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const target = String(input instanceof Request ? input.url : input);
    if (!target.includes('/api/guests/monitor/service/request')) return Response.json({});
    const request = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}')));
    if (request.method === 'POST') {
      if (JSON.parse(request.body).id === 'refresh') {
        return refreshAnswer.promise;
      }
      posts.push({ body: request.body, query: request.query });
      if (JSON.parse(request.body).id === 'watch') watching = false;
      return Response.json({ status: 204, body: '' });
    }
    reads.push(request.query);
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
          sessionId="ses_open"
          onStatusControls={(binding) => bindings.push(binding)}
        />
      </I18nProvider>,
    ));
    await settle();
    const query = { directory: '/repo', locale: 'en', sessionId: 'ses_open' };
    expect(reads).toEqual([query]);
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
    await act(async () => refreshAnswer.resolve(Response.json({ status: 204, body: '' })));
    await settle();
    expect(bindings.at(-1)?.controls[0]?.disabled).toBe(false);

    const stop = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Stop');
    if (!stop) throw new Error('Stop did not render');
    await act(async () => stop.click());
    expect(stop.textContent).toBe('Stop web?');
    expect(posts).toEqual([]);
    await act(async () => stop.click());
    await settle();
    expect(posts).toEqual([{ body: JSON.stringify({ id: 'stop-web' }), query }]);
    expect(reads.length).toBe(3);

    const watch = container.querySelector<HTMLElement>('[role="switch"]');
    if (!watch) throw new Error('Switch did not render');
    expect(watch.getAttribute('aria-checked')).toBe('true');
    await act(async () => watch.click());
    await settle();
    expect(posts.at(-1)).toEqual({ body: JSON.stringify({ id: 'watch', value: 'off' }), query });
    expect(watch.getAttribute('aria-checked')).toBe('false');
    expect(watch.hasAttribute('data-disabled')).toBe(false);

    // Folding drops the body while the service action can still fail.
    refreshAnswer = holdResponse();
    const currentHeader = bindings.at(-1);
    if (!currentHeader) throw new Error('No header binding');
    await act(async () => currentHeader.dispatch({ id: 'refresh' }));
    await act(async () => root.render(null));
    const beforeReply = reads.length;
    const message = 'Refresh refused by the service';
    await act(async () => refreshAnswer.resolve(Response.json({ status: 409, body: JSON.stringify({ message }) })));
    await settle();
    expect(toast.getHistory().some((entry) => 'title' in entry && entry.title === message && entry.type === 'error')).toBe(true);
    expect(reads).toHaveLength(beforeReply);
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
        <GuestStatusViewBody guestId="monitor" source={{ path: '/status', interval: 60_000 }} directory={null} sessionId={null} onStatusControls={() => undefined} />
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
