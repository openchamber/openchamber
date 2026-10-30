import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import type { UsageWindow } from '@/types';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Event: dom.Event });
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { UsageCard } = await import('./UsageCard');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { dict: enDict } = await import('@/lib/i18n/messages/en');
const { dict: ukDict } = await import('@/lib/i18n/messages/uk');

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
  flushSync(() => createRoot(container).render(<I18nProvider><UsageCard title="credits_balance" window={window} /></I18nProvider>));
  return container;
};

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
  flushSync(() => useI18nStore.setState({ locale: 'en', dictionary: enDict }));
});

test('changes the credits-used message when locale changes with the same quota sample', () => {
  const window = { ...balanceWindow, valueLabel: undefined, creditsUsed: 3233.27 };
  const container = render(window);
  expect(container.textContent).toContain('3,233.3 Credits Used');

  flushSync(() => useI18nStore.setState({ locale: 'uk', dictionary: ukDict }));

  expect(container.textContent).toContain('Використано кредитів: 3,233.3');
  expect(container.textContent).not.toContain('Credits Used');
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  expect(window.creditsUsed).toBe(3233.27);
});

test('cached Zen values update when the locale changes without another quota request', async () => {
  const originalLocale = useI18nStore.getState();
  const { dict: ukDictionary } = await import('@/lib/i18n/messages/uk');
  const count = render({ ...balanceWindow, valueLabel: undefined, value: { kind: 'requests', count: 292 } });
  const spend = render({ ...balanceWindow, valueLabel: undefined, value: { kind: 'spend', spent: 2, limit: null } });
  const capped = render({ ...percentWindow, value: { kind: 'spend', spent: 2, limit: 10 } });
  expect(count.textContent).toContain('Requests: 292');
  expect(spend.textContent).toContain('$2.00 spent');
  expect(capped.textContent).toContain('$2.00 of $10.00');

  flushSync(() => useI18nStore.setState({ locale: 'uk', dictionary: ukDictionary }));
  expect(count.textContent).toContain('Запити: 292');
  expect(spend.textContent).toContain('Витрачено');
  expect(capped.textContent).toContain(' з ');
  flushSync(() => useI18nStore.setState(originalLocale));
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
