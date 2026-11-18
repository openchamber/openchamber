import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installSuggestedTasksDom, deferred } from '@/lib/test-utils/suggestedTasks.fixture';
import { botItem } from '@/lib/bots/bots.fixture';

const dom = installSuggestedTasksDom();
const { I18nProvider } = await import('@/lib/i18n');
const { BotEvidence } = await import('./BotEvidence');
const { useBotResource } = await import('./useBotRequest');
let root: Root;
beforeEach(() => { root = createRoot(document.body.appendChild(document.createElement('div'))); });
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
afterAll(async () => dom.restore());

describe('Bots evidence', () => {
  test('keeps absent proof and a rejected automatic decision visible together', async () => {
    // Given an item with no proof and a judge asking for human review.
    const item = botItem({ judgment: { decision: 'review', reason: 'Public API changed', headSha: 'head', baseSha: 'base', policyFingerprint: 'policy', reviewers: ['reviewer'], questions: [] }, evidence: [{ source: 'APP-2', summary: 'Crash reproduced', url: 'javascript:alert(1)' }] });

    // When its actual evidence component renders.
    await act(async () => root.render(<I18nProvider><BotEvidence item={item} /></I18nProvider>));

    // Then the absence reason and rejection evidence are both readable, with no executable URL.
    expect(document.body.textContent).toContain(item.proof.reason);
    expect(document.body.textContent).toContain(item.judgment?.reason);
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });
});

describe('Bots read authority', () => {
  test('ignores a read started before a confirmed local mutation', async () => {
    // Given a still-running authoritative read.
    const pending = deferred<string>();
    const load = () => pending.promise;
    let state: ReturnType<typeof useBotResource<string>> | undefined;
    const Harness = () => { state = useBotResource(load); return <p>{state.data}</p>; };
    await act(async () => root.render(<Harness />));

    // When a confirmed mutation arrives before that older read.
    await act(async () => state?.replace('newer mutation'));
    await act(async () => pending.resolve('older snapshot'));

    // Then the stale read cannot revert the visible result.
    expect(document.body.textContent).toBe('newer mutation');
  });

  test('preserves the previous successful result when a refresh fails', async () => {
    // Given a successful first load and a later failed refresh.
    let fail = false;
    const load = () => fail ? Promise.reject(new Error('offline')) : Promise.resolve('recorded result');
    let state: ReturnType<typeof useBotResource<string>> | undefined;
    const Harness = () => { state = useBotResource(load); return <p>{state.data}</p>; };
    await act(async () => root.render(<Harness />));
    fail = true;

    // When refresh fails.
    await act(async () => state?.refresh());

    // Then prior data survives alongside an explicit error.
    expect(document.body.textContent).toBe('recorded result');
    expect(state?.error).toBe(true);
  });

  test('hides the previous entity immediately when its read owner changes', async () => {
    // Given one entity was successfully loaded.
    const loadA = () => Promise.resolve('entity A');
    const pendingB = deferred<string>();
    const loadB = () => pendingB.promise;
    const Harness = ({ load }: { readonly load: () => Promise<string> }) => { const state = useBotResource(load); return <p>{state.data}</p>; };
    await act(async () => root.render(<Harness load={loadA} />));

    // When another entity starts loading.
    await act(async () => root.render(<Harness load={loadB} />));

    // Then the first entity cannot appear under the second entity's controls.
    expect(document.body.textContent).toBe('');
    await act(async () => pendingB.resolve('entity B'));
  });
});
