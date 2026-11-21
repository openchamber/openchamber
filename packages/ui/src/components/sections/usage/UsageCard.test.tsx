import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import type { QuotaProviderId, UsageWindow } from '@/types';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, CustomEvent: dom.CustomEvent, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Event: dom.Event });
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
const render = (window: UsageWindow, providerId?: QuotaProviderId, title = 'credits_balance') => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  flushSync(() => createRoot(container).render(
    <I18nProvider><UsageCard title={title} window={window} providerId={providerId} /></I18nProvider>,
  ));
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

test('Claude reset labels stay stable across second-level drift at a minute boundary', () => {
  const resets = (resetAt: number, providerId: QuotaProviderId) => render({ ...percentWindow, resetAt }, providerId).textContent;
  const daysAhead = (days: number, hour: number, minute = 0) => {
    const date = new Date();
    date.setDate(date.getDate() + days);
    date.setHours(hour, minute, 0, 0);
    return date.getTime();
  };
  for (const resetAt of [daysAhead(3, 19, 40), daysAhead(5, 13)]) {
    const onMinute = resets(resetAt, 'claude');
    expect(onMinute).toContain('Resets ');
    expect(resets(resetAt - 1_000, 'claude')).toBe(onMinute);
    expect(resets(resetAt + 1_000, 'claude')).toBe(onMinute);
    expect(resets(resetAt + 60_000, 'claude')).not.toBe(onMinute);
    expect(resets(resetAt - 1_000, 'codex')).not.toBe(resets(resetAt, 'codex'));
  }
});

test('a monthly spending row shows its money without a quota bar and marks an unreadable amount', () => {
  const total = render(
    { ...balanceWindow, valueLabel: undefined, value: { kind: 'spend', spent: 226.64374512, limit: null } },
    undefined,
    'monthly_total',
  );
  expect(total.textContent).toContain('Monthly Total');
  expect(total.textContent).toContain('$226.64');
  expect(total.textContent).toContain('spent');
  expect(total.querySelector('[role="progressbar"]')).toBeNull();

  const unknown = render(
    { ...balanceWindow, valueLabel: undefined, value: { kind: 'spend', spent: null, limit: null } },
    undefined,
    'monthly_byok',
  );
  expect(unknown.textContent).toContain('Monthly BYOK');
  expect(unknown.textContent).toContain('Unknown');

  const zero = render(
    { ...balanceWindow, valueLabel: undefined, value: { kind: 'spend', spent: 0, limit: null } },
    undefined,
    'monthly_total',
  );
  expect(zero.textContent).toContain('$0.00');
});
