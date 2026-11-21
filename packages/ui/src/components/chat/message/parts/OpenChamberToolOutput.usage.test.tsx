import { afterEach, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import type { UsageWindow } from '@/types';
import type { ToolPart } from '@/lib/opencode/model';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, CustomEvent: dom.CustomEvent, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Event: dom.Event });
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { OpenChamberToolOutput } = await import('./OpenChamberToolOutput');
const { I18nProvider, useI18nStore } = await import('@/lib/i18n');
const { dict: enDict } = await import('@/lib/i18n/messages/en');

const part: ToolPart = {
  id: 'part_usage',
  sessionID: 'ses_usage',
  messageID: 'msg_usage',
  type: 'tool',
  callID: 'call_usage',
  tool: 'openchamber',
  state: { status: 'completed', input: {}, output: '', time: { start: 0, end: 1 } },
};

type UsageProviderData = {
  providerId: string;
  providerName: string;
  ok: boolean;
  usage: { windows: Record<string, UsageWindow> } | null;
};
type UsageData = { providers: UsageProviderData[] };

const spend = (spent: number | null, resetAt: number | null = null): UsageWindow => ({
  usedPercent: null,
  remainingPercent: null,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt,
  resetAtFormatted: null,
  resetAfterFormatted: null,
  value: { kind: 'spend', spent, limit: null },
});

const percent = (usedPercent: number, resetAt: number | null = null): UsageWindow => ({
  usedPercent,
  remainingPercent: 100 - usedPercent,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt,
  resetAtFormatted: null,
  resetAfterFormatted: null,
});

const zeroCap = (): UsageWindow => ({
  usedPercent: null,
  remainingPercent: null,
  windowSeconds: null,
  resetAfterSeconds: null,
  resetAt: null,
  resetAtFormatted: null,
  resetAfterFormatted: null,
  valueLabel: '$0.00 / $0.00',
});

const usageData = (providers: UsageProviderData[]): UsageData => ({ providers });

const openRouter = (windows: Record<string, UsageWindow>): UsageData => usageData([
  { providerId: 'openrouter', providerName: 'OpenRouter', ok: true, usage: { windows } },
]);

const containers: HTMLElement[] = [];
const render = (data: UsageData) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  flushSync(() => createRoot(container).render(
    <I18nProvider>
      <OpenChamberToolOutput
        envelope={{ ok: true, action: 'usage.read', data, errorMessage: undefined }}
        part={part}
        input={{}}
        directory="/repo"
        isMobile={false}
        rawToggle={null}
      />
    </I18nProvider>,
  ));
  return container;
};

afterEach(() => {
  for (const container of containers.splice(0)) container.remove();
  flushSync(() => useI18nStore.setState({ locale: 'en', dictionary: enDict }));
});

test('an uncapped OpenRouter key shows its monthly total money instead of no limit', () => {
  const container = render(openRouter({ monthly_total: spend(226.64374512) }));

  expect(container.textContent).toContain('OpenRouter');
  expect(container.textContent).toContain('$226.64');
  expect(container.textContent).toContain('spent');
  expect(container.textContent).not.toContain('No limit');
});

test('an unreadable OpenRouter monthly total stays visibly unknown', () => {
  const container = render(openRouter({ monthly_total: spend(null) }));

  expect(container.textContent).toContain('Unknown');
  expect(container.textContent).not.toContain('$0.00');
});

test('a capped OpenRouter key keeps its cap summary', () => {
  const container = render(openRouter({
    monthly: percent(40),
    monthly_total: spend(226.64374512),
  }));

  expect(container.textContent).toContain('40%');
  expect(container.textContent).not.toContain('$226.64');
});

test('keeps every provider in its four grid cells when a spending row has no percentage', () => {
  const container = render(usageData([
    {
      providerId: 'openrouter',
      providerName: 'OpenRouter',
      ok: true,
      usage: { windows: { monthly_total: spend(226.64374512, Date.UTC(2027, 0, 1)) } },
    },
    {
      providerId: 'claude',
      providerName: 'Claude',
      ok: true,
      usage: { windows: { '5h': percent(40, Date.UTC(2027, 0, 2)) } },
    },
    {
      providerId: 'gemini',
      providerName: 'Gemini',
      ok: true,
      usage: { windows: { key_limit: zeroCap(), monthly_total: spend(5, Date.UTC(2027, 0, 3)) } },
    },
  ]));
  const grid = container.querySelector('.grid');
  const cells = grid ? [...grid.children] : [];

  expect(cells).toHaveLength(10);
  expect(cells[0]?.textContent).toBe('OpenRouter');
  expect(cells[1]?.getAttribute('aria-hidden')).toBe('true');
  expect(cells[1]?.querySelector('[role="progressbar"]')).toBeNull();
  expect(cells[2]?.textContent).toContain('$226.64');
  expect(cells[3]?.textContent).not.toBe('');
  expect(cells[4]?.textContent).toBe('Claude');
  expect(cells[5]?.querySelector('[role="progressbar"]')).not.toBeNull();
  expect(cells[6]?.textContent).toBe('40%');
  expect(cells[7]?.textContent).not.toBe('');
  // Another provider's `monthly_total` is not OpenRouter's breakdown, so it keeps the generic rule.
  expect(cells[8]?.textContent).toBe('Gemini');
  expect(cells[9]?.textContent).toBe('No limit to show');
});
