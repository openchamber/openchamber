import React, { act } from 'react';
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { SurfaceInspectorRequestDetails, SurfaceNetworkEntry } from '@/lib/browser/remoteSurfaceInspectorProtocol';

const dom = new Window({ url: 'http://localhost/' });
const bindings = {
  window: dom, document: dom.document, navigator: dom.navigator,
  HTMLElement: dom.HTMLElement, Element: dom.Element, Node: dom.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = Object.keys(bindings).map((key) => ({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) }));
Object.assign(globalThis, bindings);
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { RemoteBrowserNetwork } = await import('./RemoteBrowserNetwork');
const { RemoteSurfaceInspectorError } = await import('@/lib/browser/remoteSurfaceInspector');
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
afterAll(() => {
  for (const { key, descriptor } of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  dom.happyDOM.abort();
});

const entry = (id: string): SurfaceNetworkEntry => ({
  id, timestamp: 1, method: 'GET', url: `https://fixture.test/${id}`, resourceType: 'Fetch',
  status: 200, statusText: 'OK', mimeType: 'text/plain', durationMs: 42, encodedBytes: 128,
  state: 'complete', failureText: null, fromCache: false,
});
const details = (entryId: string): SurfaceInspectorRequestDetails => ({
  type: 'inspectorRequestResult', tabId: 'tab', requestId: 'request', captureId: 'capture', entryId,
  requestHeaders: [{ name: 'accept', value: 'text/plain' }], responseHeaders: [{ name: 'content-type', value: 'text/plain' }],
  requestBody: null, responseBody: null, bodyState: 'not-requested', truncated: false,
});
const deferred = () => {
  let resolve: (value: SurfaceInspectorRequestDetails) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<SurfaceInspectorRequestDetails>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
};
const mount = async (initialEntries: readonly SurfaceNetworkEntry[] = [entry('first'), entry('second')]) => {
  const requests: Array<{ readonly entryId: string; readonly includeBody: boolean; readonly pending: ReturnType<typeof deferred> }> = [];
  const inspector = { requestDetails: (entryId: string, includeBody: boolean) => {
    const pending = deferred();
    requests.push({ entryId, includeBody, pending });
    return pending.promise;
  } };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async ({ captureId = 'capture', entries = initialEntries, filter = '' } = {}) => {
    await act(async () => root.render(<I18nProvider><RemoteBrowserNetwork
      inspector={inspector} entries={entries} captureId={captureId} filter={filter} /></I18nProvider>));
  };
  const unmount = async () => { await act(async () => root.unmount()); host.remove(); };
  cleanups.push(unmount);
  await render();
  const button = (name: string) => {
    const found = Array.from(host.querySelectorAll('button')).find((candidate) => candidate.textContent?.includes(name));
    if (!found) throw new Error(`Expected button: ${name}`);
    return found;
  };
  return { host, requests, render, button, unmount };
};

describe('remote browser network inspection', () => {
  test('requests only metadata when a row is selected', async () => {
    // Given a captured request with no details loaded.
    const view = await mount();
    expect(view.requests).toHaveLength(0);
    // When its row is selected.
    await act(async () => view.button('https://fixture.test/first').click());
    // Then no body is requested and request metadata is visible.
    expect(view.requests.map(({ entryId, includeBody }) => ({ entryId, includeBody }))).toEqual([{ entryId: 'first', includeBody: false }]);
    expect(view.host.querySelector('dl')?.textContent).toContain('42 ms');
  });

  test('requests bodies only after the explicit action and displays them as text', async () => {
    // Given metadata loaded for a selected request.
    const view = await mount();
    await act(async () => view.button('https://fixture.test/first').click());
    await act(async () => view.requests[0].pending.resolve(details('first')));
    // When the user requests body previews.
    await act(async () => view.button('Load bodies').click());
    await act(async () => view.requests[1].pending.resolve({ ...details('first'), bodyState: 'available', responseBody: '<script>alert(1)</script>', truncated: true }));
    // Then the second request opts into bodies and page markup remains inert.
    expect(view.requests[1].includeBody).toBe(true);
    expect(view.host.textContent).toContain('<script>alert(1)</script>');
    expect(view.host.querySelector('script')).toBeNull();
    expect(view.host.textContent).toContain('Preview truncated.');
  });

  test('ignores details returned for a previously selected row', async () => {
    // Given two overlapping selections.
    const view = await mount();
    await act(async () => view.button('https://fixture.test/first').click());
    await act(async () => view.button('https://fixture.test/second').click());
    await act(async () => view.requests[1].pending.resolve({ ...details('second'), responseHeaders: [{ name: 'current', value: 'second' }] }));
    // When the older selection returns later.
    await act(async () => view.requests[0].pending.resolve({ ...details('first'), responseHeaders: [{ name: 'stale', value: 'first' }] }));
    // Then only the current selection's headers remain.
    expect(view.host.textContent).toContain('current: second');
    expect(view.host.textContent).not.toContain('stale: first');
  });

  test('clears selected details and ignores old replies when capture changes', async () => {
    // Given a selected request awaiting details.
    const view = await mount();
    await act(async () => view.button('https://fixture.test/first').click());
    // When a new capture starts before the reply.
    await view.render({ captureId: 'new-capture' });
    await act(async () => view.requests[0].pending.resolve({ ...details('first'), responseHeaders: [{ name: 'stale', value: 'old capture' }] }));
    // Then the old request is no longer selected and details stay cleared.
    expect(view.host.querySelector('dl')).toBeNull();
    expect(view.host.textContent).not.toContain('old capture');
    expect(view.host.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  test('clears a removed request and ignores its late result', async () => {
    const view = await mount();
    await act(async () => view.button('https://fixture.test/first').click());
    await view.render({ entries: [] });
    await act(async () => view.requests[0].pending.resolve(details('first')));
    expect(view.host.querySelector('dl')).toBeNull();
    expect(view.host.querySelectorAll('button')).toHaveLength(0);
  });

  test('closes details without letting a pending body reply reopen them', async () => {
    const view = await mount();
    await act(async () => view.button('https://fixture.test/first').click());
    await act(async () => view.requests[0].pending.resolve(details('first')));
    await act(async () => view.button('Load bodies').click());
    await act(async () => view.button('Close request details').click());
    await act(async () => view.requests[1].pending.resolve({ ...details('first'), bodyState: 'available', responseBody: 'late body' }));
    expect(view.host.querySelector('dl')).toBeNull();
    expect(view.host.textContent).not.toContain('late body');
  });

  test('ignores a pending rejection after unmount', async () => {
    const view = await mount();
    await act(async () => view.button('https://fixture.test/first').click());
    await view.unmount();
    await act(async () => view.requests[0].pending.reject(new RemoteSurfaceInspectorError('CAPTURE_GONE')));
    expect(view.host.childNodes).toHaveLength(0);
  });

  for (const [bodyState, message] of [
    ['unavailable', 'Bodies are no longer available for this request.'],
    ['unsupported', 'Body preview is not supported for this response.'],
  ] as const) test(`reports ${bodyState} bodies while preserving headers`, async () => {
    const view = await mount();
    await act(async () => view.button('https://fixture.test/first').click());
    await act(async () => view.requests[0].pending.resolve(details('first')));
    await act(async () => view.button('Load bodies').click());
    await act(async () => view.requests[1].pending.resolve({ ...details('first'), bodyState }));
    expect(view.host.textContent).toContain(message);
    expect(view.host.textContent).toContain('accept: text/plain');
  });

  test('keeps known headers when body loading fails and permits a retry', async () => {
    const view = await mount();
    await act(async () => view.button('https://fixture.test/first').click());
    await act(async () => view.requests[0].pending.resolve(details('first')));
    await act(async () => view.button('Load bodies').click());
    await act(async () => view.requests[1].pending.reject(new RemoteSurfaceInspectorError('REQUEST_FAILED')));
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Could not load request details.');
    expect(view.host.textContent).toContain('accept: text/plain');
    expect(view.button('Load bodies').disabled).toBe(false);
  });

  test('shows a typed missing-request error without exposing arbitrary error details', async () => {
    const view = await mount();
    await act(async () => view.button('https://fixture.test/first').click());
    await act(async () => view.requests[0].pending.reject(new RemoteSurfaceInspectorError('REQUEST_GONE')));
    expect(view.host.querySelector('[role="alert"]')?.textContent).toBe('This request is no longer available.');
  });

  test('filters requests without discarding a selected detail or fetching again', async () => {
    const view = await mount();
    await act(async () => view.button('https://fixture.test/first').click());
    await act(async () => view.requests[0].pending.resolve(details('first')));
    await view.render({ filter: 'SECOND' });
    const list = view.host.querySelector('ul');
    expect(list?.querySelectorAll('button')).toHaveLength(1);
    expect(list?.textContent).toContain('https://fixture.test/second');
    expect(view.host.querySelector('dl')?.textContent).toContain('https://fixture.test/first');
    expect(view.requests).toHaveLength(1);
  });

  test('keeps the last request selectable at the capture row limit', async () => {
    const view = await mount(Array.from({ length: 200 }, (_, index) => entry(`row-${index}`)));
    await act(async () => view.button('https://fixture.test/row-199').click());
    expect(view.requests[0].entryId).toBe('row-199');
    expect(view.host.querySelector('ul')?.children).toHaveLength(200);
  });
});
