import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { I18nKey, I18nParams } from '@/lib/i18n';
import { dict as en } from '@/lib/i18n/messages/en';
import { formatMessage } from '@/lib/i18n/store';
import { PrChecksValue } from './PrChecksValue';
import { prChecksTooltip, type PrChecks } from './prChecks';

const t = (key: I18nKey, params?: I18nParams): string => formatMessage(en, key, params);

const cases: Array<{ name: string; checks: PrChecks; dot: string; tooltip: string }> = [
  {
    name: 'a failed check turns the dot red over a running one',
    checks: { total: 9, success: 7, failure: 1, pending: 1 },
    dot: 'var(--status-error)',
    tooltip: '1 failed · 1 running · 7 passed',
  },
  {
    name: 'a running check turns the dot yellow',
    checks: { total: 9, success: 8, failure: 0, pending: 1 },
    dot: 'var(--status-warning)',
    tooltip: '1 running · 8 passed',
  },
  {
    name: 'all passed turns the dot green',
    checks: { total: 9, success: 9, failure: 0, pending: 0 },
    dot: 'var(--status-success)',
    tooltip: '9 passed',
  },
];

test('the Checks row shows passed out of all, a dot coloured by the worst state, and the split in its tooltip', async () => {
  const dom = new Window({ url: 'http://status.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    HTMLElement: dom.HTMLElement,
    Event: dom.Event,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  try {
    for (const { name, checks, dot, tooltip } of cases) {
      await act(async () => root.render(<PrChecksValue checks={checks} />));
      expect(`${name}: ${container.textContent}`).toBe(`${name}: ${checks.success}/${checks.total}`);
      const dotElement = container.querySelector<HTMLElement>('[data-pr-checks-dot]');
      expect(`${name}: ${dotElement?.style.backgroundColor}`).toBe(`${name}: ${dot}`);
      expect(`${name}: ${prChecksTooltip(checks, t)}`).toBe(`${name}: ${tooltip}`);
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    await dom.happyDOM.close();
  }
});
