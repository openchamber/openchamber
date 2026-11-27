import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React from 'react';
import type { JsonValue } from '@openchamber/sdk';

const dom = new Window();
Object.assign(globalThis, { window: dom, document: dom.document, CustomEvent: dom.CustomEvent, localStorage: dom.localStorage, HTMLElement: dom.HTMLElement, Event: dom.Event });
const { createRoot } = await import('react-dom/client');
const { flushSync } = await import('react-dom');
const { LeadToolOutput } = await import('./LeadToolOutput');
const { I18nProvider } = await import('@/lib/i18n');

const render = (data: JsonValue, strands: Record<string, string | boolean>[] = []) => {
  const host = document.createElement('div');
  const root = createRoot(host);
  flushSync(() => root.render(
    <I18nProvider>
      <LeadToolOutput
        envelope={{ ok: true, action: 'lead.brief', data, errorMessage: undefined }}
        input={{ action: 'lead.brief', parameters: { strands } }}
        directory="/repo"
        isMobile={false}
        rawToggle={null}
      />
    </I18nProvider>,
  ));
  const { textContent } = host;
  root.unmount();
  return textContent;
};

test('the brief card names each strand that was set with its new text, and each closed one', () => {
  const shown = render({ saved: true, length: 40, limit: 12000 }, [{ id: 'ci', text: 'Waits on the VM' }, { id: 'relay', close: true }]);
  expect(shown).toContain('ciWaits on the VM');
  expect(shown).toContain('relay: closed');
  expect(shown).toContain('40 of 12000');
});

test('a read brief shows its strands below the free text, and the size of both', () => {
  const shown = render({ brief: '# Goal', strands: [{ id: 'ci', text: 'Green main' }], length: 90, limit: 12000, empty: false });
  expect(shown).toContain('# Goal');
  expect(shown).toContain('ciGreen main');
  expect(shown).toContain('90 of 12000');
});
