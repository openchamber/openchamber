import { afterAll, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { GuestLinkRule } from '@/lib/guests/links';

const browser = new Window({ url: 'http://localhost/' });
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
browser.document.write('<!doctype html><html><head></head><body></body></html>');
Object.assign(globalThis, {
  window: browser, document: browser.document, Event: browser.Event, CustomEvent: browser.CustomEvent,
  navigator: browser.navigator, localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  HTMLElement: browser.HTMLElement, HTMLAnchorElement: browser.HTMLAnchorElement, Element: browser.Element,
  Node: browser.Node, Text: browser.Text, SVGElement: browser.SVGElement, customElements: browser.customElements,
  MutationObserver: browser.MutationObserver, DOMParser: browser.DOMParser, XMLSerializer: browser.XMLSerializer,
  IntersectionObserver: browser.IntersectionObserver, ResizeObserver: browser.ResizeObserver,
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true });
const { MarkdownContent } = await import('../MarkdownRendererImpl');
const { I18nProvider } = await import('@/lib/i18n');
const { useGuestsStore } = await import('@/lib/guests/store');
const host = document.createElement('div');
document.body.append(host);
const root = createRoot(host);
afterAll(async () => { await act(() => root.unmount()); browser.happyDOM.abort(); globalThis.fetch = originalFetch; });

const rules: GuestLinkRule[] = [{ guestId: 'tasks-demo', action: 'open', keys: ['DEMO'], urls: null }];
useGuestsStore.setState({ guests: [{ id: 'tasks-demo', name: 'Task Board', icon: 'task', entry: 'panel/index.html', capabilities: { requested: ['links'], granted: ['links'] } }] });
const formula = '\\[\nx+\n\ny\n\\]';
const draw = async (content: string, guestLinks: readonly GuestLinkRule[], streaming: boolean, mode: 'static' | 'streaming' = 'streaming') => act(() => root.render(
  <I18nProvider><MarkdownContent content={content} guestLinks={guestLinks} mode={mode} isStreaming={streaming} enableFileReferences={false} /></I18nProvider>,
));

test('renders a formula after the reply streams and keeps the extension link', async () => {
  await draw(`Task DEMO-2.\n\n${formula}`, rules, true);
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.querySelector('[data-oc-guest-link]')?.textContent).toBe('DEMO-2');
  await draw(`Task DEMO-2.\n\n${formula}\n\nDone.`, rules, false);
  expect(host.querySelector('.katex-display')).not.toBeNull();
  expect(host.querySelector('[data-oc-guest-link]')?.textContent).toBe('DEMO-2');
});

test('keeps an extension identifier inside a candidate as a link', async () => {
  const text = '\\[\nx+\n\nDEMO-2\n\\]';
  await draw(text, rules, false);
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.querySelector('[data-oc-guest-link]')?.textContent).toBe('DEMO-2');
});

test('rechecks a visible message when extension rules change', async () => {
  const text = '\\[\nx+\n\nDEMO-2\n\\]';
  await draw(text, [], false);
  expect(host.querySelector('.katex-display')).not.toBeNull();
  await draw(text, rules, false);
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.querySelector('[data-oc-guest-link]')?.textContent).toBe('DEMO-2');
  await draw(text, [], false);
  expect(host.querySelector('.katex-display')).not.toBeNull();
});

test('rechecks a streaming message when extension rules change', async () => {
  const text = '\\[\nx+\n\nDEMO-2\n\\]';
  await draw(text, [], true);
  expect(host.querySelector('.katex-display')).not.toBeNull();
  await draw(text, rules, true);
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.querySelector('[data-oc-guest-link]')?.textContent).toBe('DEMO-2');
  await draw(text, [], true);
  expect(host.querySelector('.katex-display')).not.toBeNull();
});

test('renders static history with an extension link and a formula', async () => {
  await draw(`Task DEMO-2.\n\n${formula}`, rules, false, 'static');
  expect(host.querySelector('.katex-display annotation')?.textContent).toContain('x+\n\ny');
  expect(host.querySelector('[data-oc-guest-link]')?.textContent).toBe('DEMO-2');
});

test('keeps the existing rendering when static mode is still streaming', async () => {
  await draw(`Task DEMO-2.\n\n${formula}`, rules, true, 'static');
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.querySelector('[data-oc-guest-link]')?.textContent).toBe('DEMO-2');
});

test('handles multiple candidates independently', async () => {
  const text = `${formula}\n\n\\[\nx+\n\nDEMO-2\n\\]`;
  await draw(text, rules, false);
  expect(host.querySelectorAll('.katex-display')).toHaveLength(1);
  expect(host.querySelector('[data-oc-guest-link]')?.textContent).toBe('DEMO-2');
});

test('keeps an identifier that Remend exposes inside unfinished emphasis', async () => {
  const text = 'Intro _\n\n\\[\nx\n\n_DEMO-2\n\\]';
  await draw(text, rules, true);
  expect(host.querySelector('[data-oc-guest-link]')?.textContent).toBe('DEMO-2');
  expect(host.textContent).not.toContain('$$');
});

test('keeps an identifier that Remend joins from an unfinished link', async () => {
  const text = '\\[\nx\n\nDEM[O-2](url\n\\]';
  await draw(text, rules, true);
  expect(host.querySelector('[data-oc-guest-link]')?.textContent).toBe('DEMO-2');
  expect(host.textContent).not.toContain('$$');
});

test('keeps a guest link before math when Remend sees an unfinished HTML tag', async () => {
  const text = 'See <DEMO-2\n\n\\[\nx > 0\n\ny\n\\]';
  await draw(text, rules, true);
  expect(host.querySelector('[data-oc-guest-link]')?.textContent).toBe('DEMO-2');
  expect(host.textContent).toContain('x > 0');
});

test('keeps an identifier inside math with an unmatched bracket while streaming', async () => {
  const text = '\\[\nx [0,1)\n\nDEMO-2\n\\]';
  await draw(text, rules, true);
  expect(host.querySelector('.katex-display')).toBeNull();
  expect(host.querySelector('[data-oc-guest-link]')?.textContent).toBe('DEMO-2');
});
