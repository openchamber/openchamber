import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SuggestionInbox } from '@/lib/suggestedTasksApi';
import { deferred, inbox, installSuggestedTasksDom, serveSuggestedTasks, suggestion } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const bootstrapServer = await serveSuggestedTasks(() => Response.json({}));
const { I18nProvider } = await import('@/lib/i18n');
const { fetchSuggestionInbox } = await import('@/lib/suggestedTasksApi');
const { getSuggestedTasksRuntime } = await import('@/lib/suggestedTasksRuntime');
const { useSuggestedTasksStore } = await import('@/stores/useSuggestedTasksStore');
const { SuggestionCard } = await import('./SuggestionCard');
const { SuggestedTasksRun } = await import('./SuggestedTasksRun');
const { useSuggestionActions } = await import('./useSuggestionActions');

let server: Awaited<ReturnType<typeof serveSuggestedTasks>>;
let root: Root;
let payload: SuggestionInbox;
const writes: string[] = [];
let capturedActions: ReturnType<typeof useSuggestionActions> | undefined;
const Harness = () => {
  const entry = useSuggestedTasksStore((state) => state.inboxes.app);
  const actions = useSuggestionActions({ id: 'app', path: '/repo' }, () => undefined);
  capturedActions = actions;
  const item = entry && entry.status !== 'loading' ? entry.inbox?.suggestions[0] : null;
  return item ? <SuggestionCard suggestion={item} projectPath="/repo" issueProviders={['github']} canCreateWorktree botsAvailable={false} busy={actions.busyIds.has(item.id)} onDecide={(decision) => void actions.decide(item, decision)} /> : null;
};
beforeEach(async () => {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  payload = inbox([suggestion()]);
  writes.length = 0;
  server = await serveSuggestedTasks((request) => {
    if (request.method === 'GET') return Response.json(payload);
    writes.push(new URL(request.url).pathname.split('/').pop() ?? '');
    return Response.json({ suggestion: suggestion({ status: 'open', conversionPending: false }) });
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  await server.stop(true);
  document.body.replaceChildren();
});
afterAll(async () => { await bootstrapServer.stop(true); await dom.restore(); });

const renderCard = async () => {
  await useSuggestedTasksStore.getState().loadInbox('app');
  await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));
};
const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};

describe('Suggested tasks server lifecycle', () => {
  test('parses and renders a pending lens with its timer and incomplete-read warnings', async () => {
    // Given the server has recorded a lens before dispatch and a partial issue read.
    payload = {
      ...inbox(),
      runs: [{
        id: 'run-1', reason: 'manual', startedAt: 1, status: 'running', error: 'One lens failed', warnings: ['Issue provider unavailable'],
        lenses: [{ lensId: 'lens-1', lensName: 'Security', action: 'suggest', status: 'pending', startedAt: 1, reported: 0, added: 0, tokens: 0 }],
      }],
    };

    // When the real API boundary parses the inbox and the run is rendered.
    const received = await fetchSuggestionInbox('app');
    const run = received.runs[0];
    if (!run) throw new Error('Missing run');
    await act(async () => root.render(<I18nProvider><SuggestedTasksRun run={run} onOpenSession={() => undefined} onStop={() => undefined} /></I18nProvider>));

    // Then pending is accepted, rendered without a spinner, and both diagnostics stay visible.
    expect(run.lenses[0]?.status).toBe('pending');
    expect(document.querySelector('li svg use')?.getAttribute('href')).toBe('#oc-timer');
    expect(document.querySelector('li svg')?.classList.contains('animate-spin')).toBe(false);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('One lens failed');
    const warning = [...document.querySelectorAll('p')].find((entry) => entry.textContent === 'Issue provider unavailable');
    expect(warning?.classList.contains('text-[var(--status-warning)]')).toBe(true);
  });

  for (const status of ['open', 'snoozed'] as const) {
    test(`disables approval, dismissal, snooze and early restore for a reserved ${status} suggestion`, async () => {
      // Given a server-reserved conversion without a recoverable error.
      payload = inbox([suggestion({ status, conversionPending: true, conversionError: 'An older attempt failed.', conversionRecoverable: false })]);

      // When its parsed card is rendered.
      await renderCard();

      // Then all mutating entry points are disabled and recovery is not offered.
      for (const label of ['Start session', 'Approve as', 'Snooze', 'Dismiss']) expect(button(label).disabled).toBe(true);
      expect([...document.querySelectorAll('button')].some((entry) => entry.textContent?.trim() === 'Restore')).toBe(false);
      if (status === 'snoozed') expect(button('Show now').disabled).toBe(true);
    });
  }

  test('does not expose restore for a reserved dismissed suggestion without an error', async () => {
    // Given an outstanding conversion reservation on a dismissed record.
    payload = inbox([suggestion({ status: 'dismissed', conversionPending: true })]);

    // When its parsed card is rendered.
    await renderCard();

    // Then a reservation cannot be cleared while its outcome is still pending.
    expect([...document.querySelectorAll('button')].some((entry) => entry.textContent?.trim() === 'Restore')).toBe(false);
  });

  test('offers explicit restore after a reserved conversion error and enables retry only after restore succeeds', async () => {
    // Given an uncertain conversion whose error tells the user to check its outcome.
    payload = inbox([suggestion({ status: 'approved', conversionPending: true, conversionRecoverable: true, conversionError: 'Check whether the session was created before restoring.' })]);
    await renderCard();
    const restored = deferred<void>();
    const release = useSuggestedTasksStore.subscribe((state) => {
      const entry = state.inboxes.app;
      if (entry?.status === 'ready' && entry.inbox.suggestions[0]?.conversionPending === false) restored.resolve();
    });

    // When the user explicitly restores after checking the displayed failure.
    expect(document.body.textContent).toContain('Check whether the session was created before restoring.');
    await act(async () => { button('Restore').click(); await restored.promise; });
    release();

    // Then only restore was sent and approval is enabled by the confirmed cleared reservation.
    expect(writes).toEqual(['restore']);
    expect(button('Start session').disabled).toBe(false);
  });

  test('blocks stale mutation handlers after the authoritative inbox reserves the conversion', async () => {
    // Given handlers captured before a reservation arrives.
    await renderCard();
    const oldActions = capturedActions;
    if (!oldActions) throw new Error('Missing actions');
    const oldItem = suggestion();
    await act(async () => useSuggestedTasksStore.getState().applySuggestion('app', suggestion({ conversionPending: true }), getSuggestedTasksRuntime()));

    // When old handlers try to mutate the now-reserved suggestion.
    await act(async () => {
      await oldActions.decide(oldItem, { kind: 'approve', action: 'session' });
      await oldActions.decide(oldItem, { kind: 'dismiss' });
      await oldActions.decide(oldItem, { kind: 'snooze', until: 10 });
      await oldActions.decide(oldItem, { kind: 'restore' });
    });

    // Then no mutation or dismiss flow is admitted.
    expect(writes).toEqual([]);
    expect(capturedActions?.dismissTarget).toBeNull();
  });

  test('blocks submission from a dismissal dialog opened before the reservation arrived', async () => {
    // Given an open dismissal flow for a suggestion that subsequently becomes reserved.
    await renderCard();
    await act(async () => { await capturedActions?.decide(suggestion(), { kind: 'dismiss' }); });
    await act(async () => useSuggestedTasksStore.getState().applySuggestion('app', suggestion({ conversionPending: true }), getSuggestedTasksRuntime()));

    // When the older dismissal flow submits its reason.
    let dismissed: boolean | undefined;
    await act(async () => { dismissed = await capturedActions?.dismiss('No longer needed'); });

    // Then it cannot bypass the new reservation.
    expect(dismissed).toBe(false);
    expect(writes).toEqual([]);
  });

  test('does not submit a stale dismissal after the suggestion was approved', async () => {
    await renderCard();
    await act(async () => { await capturedActions?.decide(suggestion(), { kind: 'dismiss' }); });
    await act(async () => useSuggestedTasksStore.getState().applySuggestion('app', suggestion({ status: 'approved', conversion: { kind: 'session', sessionId: 'created' } }), getSuggestedTasksRuntime()));
    await act(async () => { expect(await capturedActions?.dismiss('old dialog')).toBe(false); });
    expect(writes).toEqual([]);
    expect(capturedActions?.dismissTarget).toBeNull();
  });
});
