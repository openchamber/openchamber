import { expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import type { Message, Metadata } from '@/lib/opencode/model';
import { I18nProvider } from '@/lib/i18n';
import { dict } from '@/lib/i18n/messages/en';
import { SyncProvider } from '@/sync/sync-context';
import { TimelineNotice } from './TimelineNotice';

const sdk = OpenCode.make({ baseUrl: 'http://timeline.test', fetch: () => new Promise<Response>(() => undefined) });
const scenarios: readonly { readonly name: string; readonly metadata: Metadata }[] = [
  { name: 'restart continuation', metadata: { source: 'openchamber-notice', kind: 'restart-resume', at: 5, cause: 'process-exited', tool: null } },
  { name: 'interrupted question answer', metadata: { source: 'openchamber-notice', kind: 'question-answer', at: 5, cause: 'inactivity', answers: [{ question: 'Color?', answer: 'Blue' }] } },
  { name: 'PR fix-loop report', metadata: { source: 'openchamber-notice', kind: 'fix-loop', loopId: 'loop-1' } },
];

for (const scenario of scenarios) {
  test(`a ${scenario.name} renders as a collapsed recovery row`, () => {
    // Given
    const message: Message = { id: 'resume', sessionID: 'session', role: 'synthetic', time: { created: 9 }, text: 'Agent context', metadata: scenario.metadata };
    const browser = new Window();
    try {
      // When
      browser.document.body.innerHTML = renderToStaticMarkup(
        <SyncProvider sdk={sdk} directory=""><I18nProvider><TimelineNotice message={message} /></I18nProvider></SyncProvider>,
      );

      // Then
      const toggle = browser.document.querySelector('[role="button"][aria-expanded]');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');
      expect(toggle?.getAttribute('aria-label')).toBe(dict['chat.openchamberResume.show']);
    } finally {
      browser.close();
    }
  });
}
