import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import type { UsageWindow } from '@/types';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Event: dom.Event });
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { UsageCard } = await import('./UsageCard');

const balanceWindow: UsageWindow = {
  usedPercent: null,
  remainingPercent: null,
  valueLabel: '¥635.27',
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
};

const percentWindow: UsageWindow = {
  ...balanceWindow,
  usedPercent: 42,
  remainingPercent: 58,
  valueLabel: null,
};

const containers: HTMLElement[] = [];
const render = (window: UsageWindow) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  flushSync(() => createRoot(container).render(<UsageCard title="credits_balance" window={window} />));
  return container;
};

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
});

test('a balance-only window shows its value without a progress bar or "used" caption', () => {
  const container = render(balanceWindow);

  expect(container.textContent).toContain('¥635.27');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  expect(container.textContent).not.toContain('used');
});

test('a window with a percentage keeps its progress bar and caption', () => {
  const container = render(percentWindow);

  expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('42');
  expect(container.textContent).toContain('used');
});
