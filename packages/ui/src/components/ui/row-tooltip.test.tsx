import { afterAll, afterEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
const descriptors = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  Text: browser.Text,
  Event: browser.Event,
  MouseEvent: browser.MouseEvent,
  PointerEvent: browser.PointerEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

const { createRoot } = await import('react-dom/client');
const { DelegatedTooltip, HoverTooltip } = await import('./row-tooltip');

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [name, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

const DELAY_MS = 350;

const wait = (ms: number) => act(() => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));

const pointer = (type: string, init: { pointerType?: string; buttons?: number } = {}) => (
  new window.PointerEvent(type, { bubbles: type !== 'pointerleave', pointerType: init.pointerType ?? 'mouse', buttons: init.buttons ?? 0 })
);

const tooltipText = () => document.querySelector('[data-slot="tooltip-content"]')?.textContent ?? null;

let root: Root | null = null;
let host: HTMLElement | null = null;
let list: HTMLElement | null = null;

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  host?.remove();
  list?.remove();
  root = null;
  host = null;
  list = null;
});

const render = async (node: React.ReactNode) => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => { root?.render(node); });
};

const mountDelegated = async () => {
  const container = document.createElement('div');
  list = container;
  container.innerHTML = `
    <button id="pin" data-row-tooltip="Pin it"><span id="icon"></span></button>
    <button id="send" data-row-tooltip="Send it"></button>
    <p id="plain"></p>`;
  document.body.append(container);
  await render(<DelegatedTooltip containerRef={{ current: container }} />);
  const dispatch = (id: string, event: Event) => act(async () => { container.querySelector(`#${id}`)?.dispatchEvent(event); });
  const over = (id: string, init?: Parameters<typeof pointer>[1]) => dispatch(id, pointer('pointerover', init));
  return { container, dispatch, over };
};

test('delegated: opens after the hover delay on the hovered control, from a child of it too', async () => {
  const { over } = await mountDelegated();
  await over('icon');
  expect(tooltipText()).toBeNull();
  await wait(DELAY_MS);
  expect(tooltipText()).toBe('Pin it');
  await act(async () => { root?.unmount(); });
  root = null;
  expect(tooltipText()).toBeNull();
});

test('delegated: moving to the next control while one is open switches at once, and leaving closes it', async () => {
  const { container, over } = await mountDelegated();
  await over('pin');
  await wait(DELAY_MS);
  await over('send');
  expect(tooltipText()).toBe('Send it');
  await over('plain');
  expect(tooltipText()).toBeNull();

  await over('pin');
  await wait(DELAY_MS);
  await act(async () => { container.dispatchEvent(pointer('pointerleave')); });
  expect(tooltipText()).toBeNull();
});

test('delegated: a press closes it and it stays closed while the pointer stays on that control', async () => {
  const { dispatch, over } = await mountDelegated();
  await over('pin');
  await wait(DELAY_MS);
  await dispatch('pin', pointer('pointerdown'));
  expect(tooltipText()).toBeNull();
  await over('icon');
  await wait(DELAY_MS);
  expect(tooltipText()).toBeNull();
});

test('delegated: a touch or a drag in progress opens nothing', async () => {
  const { over } = await mountDelegated();
  await over('pin', { pointerType: 'touch' });
  await over('send', { buttons: 1 });
  await wait(DELAY_MS);
  expect(tooltipText()).toBeNull();
});

test('delegated: a click, a key or a scroll closes it', async () => {
  const { dispatch, over } = await mountDelegated();
  for (const event of [
    new window.MouseEvent('click', { bubbles: true }),
    new window.Event('keydown', { bubbles: true }),
    new window.Event('scroll'),
  ]) {
    await over('plain');
    await over('pin');
    await wait(DELAY_MS);
    expect(tooltipText()).toBe('Pin it');
    await dispatch('pin', event);
    expect(tooltipText()).toBeNull();
  }
});

test('hover: adds no DOM around the button, mounts no tooltip at rest, and keeps the button\'s own handlers', async () => {
  let pressed = 0;
  await render(
    <HoverTooltip label="Copy code">
      <button type="button" onPointerDown={() => { pressed += 1; }}>x</button>
    </HoverTooltip>,
  );
  const button = host?.querySelector('button');
  expect(button?.parentElement).toBe(host);
  expect(host?.childElementCount).toBe(1);
  expect(tooltipText()).toBeNull();

  await act(async () => { button?.dispatchEvent(pointer('pointerdown')); });
  expect(pressed).toBe(1);
});
