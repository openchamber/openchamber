import { afterEach, beforeEach, expect, jest, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { useDurationTickerNow, useMinuteTickerNow, useSpinnerPhase, useWaitingBlink } from './useDurationTicker';

let root: Root | null = null;
let host: HTMLElement;
const originals = new Map<string, PropertyDescriptor | undefined>();

const Indicator: React.FC<{ id: string; active?: boolean }> = ({ id, active = true }) => (
  <span data-id={id} className={useWaitingBlink(active)} />
);

const Counter: React.FC = () => <span data-id="counter">{useDurationTickerNow(true)}</span>;

const SpinnerProbe: React.FC = () => <span data-id="spinner">{useSpinnerPhase(true, 8)}</span>;

const classOf = (id: string) => host.querySelector(`[data-id="${id}"]`)?.className ?? null;

const render = (element: React.ReactElement) => act(async () => root?.render(element));

const advance = (milliseconds: number) => act(async () => {
  jest.advanceTimersByTime(milliseconds);
});

beforeEach(() => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  jest.useFakeTimers();
  host = document.createElement('div');
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  jest.useRealTimers();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  originals.clear();
});

test('waiting indicators toggle dim once a second, all in the same phase whenever they mounted', async () => {
  await render(<Indicator id="first" />);
  expect(classOf('first')).toBe('');

  await advance(1000);
  expect(classOf('first')).toBe('waiting-dim');

  // A second indicator mounted mid-cycle joins the current phase.
  await render(<><Indicator id="first" /><Indicator id="second" /></>);
  expect(classOf('second')).toBe('waiting-dim');

  await advance(1000);
  expect(classOf('first')).toBe('');
  expect(classOf('second')).toBe('');

  await advance(1000);
  expect(classOf('first')).toBe('waiting-dim');
  expect(classOf('second')).toBe('waiting-dim');
});

test('an indicator that is not waiting stays bright and keeps no timer', async () => {
  const setInterval = spyOn(window, 'setInterval');
  await render(<Indicator id="still" active={false} />);
  expect(setInterval.mock.calls.length).toBe(0);
  setInterval.mockRestore();

  await advance(3000);
  expect(classOf('still')).toBe('');
});

test('a spinner steps four times a second and blinks change on its fourth step, from one timer', async () => {
  const setInterval = spyOn(window, 'setInterval');
  await render(<><SpinnerProbe /><Indicator id="blink" /></>);
  const spinner = () => host.querySelector('[data-id="spinner"]')?.textContent;
  expect(spinner()).toBe('0');

  await advance(750);
  expect(spinner()).toBe('3');
  expect(classOf('blink')).toBe('');

  await advance(250);
  expect(spinner()).toBe('4');
  expect(classOf('blink')).toBe('waiting-dim');
  expect(setInterval.mock.calls.map((call) => call[1])).toEqual([250]);
  setInterval.mockRestore();
});

test('a blink keeps its 1 s rhythm after the last spinner leaves mid-second', async () => {
  await render(<><SpinnerProbe /><Indicator id="blink" /></>);
  await advance(500);
  await render(<Indicator id="blink" />);
  expect(classOf('blink')).toBe('');

  await advance(1000);
  expect(classOf('blink')).toBe('waiting-dim');
  await advance(1000);
  expect(classOf('blink')).toBe('');
});

test('waiting indicators and live counters share one 1 s timer', async () => {
  const setInterval = spyOn(window, 'setInterval');
  await render(<><Indicator id="blink" /><Indicator id="other" /><Counter /></>);
  expect(setInterval.mock.calls.length).toBe(1);
  expect(setInterval.mock.calls[0]?.[1]).toBe(1000);
  setInterval.mockRestore();
});

test('a minute clock renders again only when the minute turns', async () => {
  let renders = 0;
  const MinuteProbe: React.FC = () => {
    renders += 1;
    return <span data-id="minute">{useMinuteTickerNow(true)}</span>;
  };
  await render(<MinuteProbe />);
  const first = renders;
  // The fake timers move Date.now() along with them.
  const untilMinute = 60_000 - (Date.now() % 60_000);

  await advance(Math.max(0, untilMinute - 1500));
  expect(renders).toBe(first);

  await advance(3000);
  expect(renders).toBe(first + 1);
});
