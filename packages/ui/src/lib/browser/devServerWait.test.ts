import { describe, expect, test } from 'bun:test';

import {
  DEV_SERVER_FIRST_RETRY_MS,
  DEV_SERVER_MAX_RETRY_MS,
  DEV_SERVER_WAIT_MS,
  acceptsBrowserTabLoadRequest,
  type DevServerWaitRun,
  forgetBrowserTabOpenedWithAddress,
  noteBrowserTabOpenedWithAddress,
  planFailedLoadRetry,
  requestBrowserTabLoad,
  subscribeBrowserTabLoadRequests,
  wasBrowserTabOpenedWithAddress,
} from './devServerWait';

const REFUSED = -102;
const DEAD_PORT = 'http://localhost:8481/';

describe('dev server wait', () => {
  const failure = { code: REFUSED, url: DEAD_PORT };
  const watching = { restored: false, watched: true };

  test('a restored load that fails is not retried, watched or not', () => {
    expect(planFailedLoadRetry(failure, { run: null, restored: true, watched: true, now: 1_000 }).next).toBe('stop');
    expect(planFailedLoadRetry(failure, { run: null, restored: true, watched: false, now: 1_000 }).next).toBe('stop');
  });

  test('a load someone started is retried while the server comes up', () => {
    const first = planFailedLoadRetry(failure, { ...watching, run: null, now: 1_000 });
    expect(first).toEqual({ next: 'retry', delayMs: DEV_SERVER_FIRST_RETRY_MS, run: { url: DEAD_PORT, startedAt: 1_000, paused: false } });

    const later = planFailedLoadRetry(failure, { ...watching, run: first.run, now: 20_000 });
    expect(later.next).toBe('retry');
    expect(later.run).toEqual(first.run);
  });

  test('the pause starts short and grows to the cap as the wait goes on', () => {
    const run = { url: DEAD_PORT, startedAt: 0, paused: false };
    const delayAt = (now: number) => {
      const plan = planFailedLoadRetry(failure, { ...watching, run, now });
      return plan.next === 'retry' ? plan.delayMs : null;
    };
    expect(delayAt(0)).toBe(DEV_SERVER_FIRST_RETRY_MS);
    expect(delayAt(4_000)).toBe(2_000);
    expect(delayAt(30_000)).toBe(DEV_SERVER_MAX_RETRY_MS);
  });

  test('a server that stays down is retried about 15 times over the whole wait', () => {
    // A fixed 600 ms pause made this about 65 page loads per tab.
    let run: DevServerWaitRun | null = null;
    let now = 0;
    let loads = 0;
    for (;;) {
      const plan = planFailedLoadRetry(failure, { ...watching, run, now });
      run = plan.run;
      if (plan.next !== 'retry') break;
      loads += 1;
      now += plan.delayMs;
    }
    expect(loads).toBeGreaterThanOrEqual(12);
    expect(loads).toBeLessThanOrEqual(18);
  });

  test('the wait ends once the run has lasted the whole budget', () => {
    const run = { url: DEAD_PORT, startedAt: 1_000, paused: false };
    const plan = planFailedLoadRetry(failure, { ...watching, run, now: 1_001 + DEV_SERVER_WAIT_MS });
    expect(plan).toEqual({ next: 'stop', run });
  });

  test('a tab nobody watches holds its retry back and retries at once when watched again', () => {
    const first = planFailedLoadRetry(failure, { ...watching, run: null, now: 1_000 });
    const hidden = planFailedLoadRetry(failure, { ...watching, watched: false, run: first.run, now: 6_000 });
    expect(hidden).toEqual({ next: 'pause', run: { url: DEAD_PORT, startedAt: 1_000, paused: true } });

    const shown = planFailedLoadRetry(failure, { ...watching, run: hidden.run, now: 20_000 });
    expect(shown).toEqual({ next: 'retry', delayMs: DEV_SERVER_FIRST_RETRY_MS, run: { url: DEAD_PORT, startedAt: 1_000, paused: false } });
  });

  test('a wait that ran out in view keeps its error when the tab is hidden and shown again', () => {
    const run = { url: DEAD_PORT, startedAt: 1_000, paused: false };
    const now = 2_000 + DEV_SERVER_WAIT_MS;
    expect(planFailedLoadRetry(failure, { ...watching, run, now }).next).toBe('stop');
    expect(planFailedLoadRetry(failure, { ...watching, watched: false, run, now: now + 5_000 }).next).toBe('stop');
    expect(planFailedLoadRetry(failure, { ...watching, run, now: now + 10_000 }).next).toBe('stop');
  });

  test('a tab held back past the end of the wait retries once when shown, then shows the error', () => {
    const hidden = planFailedLoadRetry(failure, { ...watching, watched: false, run: null, now: 1_000 });
    const shown = planFailedLoadRetry(failure, { ...watching, run: hidden.run, now: 120_000 });
    expect(shown.next).toBe('retry');
    expect(planFailedLoadRetry(failure, { ...watching, run: shown.run, now: 120_600 }).next).toBe('stop');
  });

  test('a public site that refused is not retried', () => {
    const plan = planFailedLoadRetry({ code: REFUSED, url: 'https://example.com/' }, { ...watching, run: null, now: 1_000 });
    expect(plan.next).toBe('stop');
  });

  test('a tab opened with an address counts as opened now only until it has mounted', () => {
    const tabID = 'browser:http://localhost:8481/';
    expect(wasBrowserTabOpenedWithAddress('/repo', tabID)).toBe(false);

    noteBrowserTabOpenedWithAddress('/repo', tabID);
    expect(wasBrowserTabOpenedWithAddress('/repo', tabID)).toBe(true);
    expect(wasBrowserTabOpenedWithAddress('/repo', tabID)).toBe(true);
    // The same address in another project is a different tab.
    expect(wasBrowserTabOpenedWithAddress('/other', tabID)).toBe(false);

    forgetBrowserTabOpenedWithAddress('/repo', tabID);
    expect(wasBrowserTabOpenedWithAddress('/repo', tabID)).toBe(false);
  });

  test('a load request reaches only the mounted tab it names, until it unsubscribes', () => {
    const tabID = 'browser:http://localhost:5173/';
    const loads: string[] = [];
    const stop = subscribeBrowserTabLoadRequests('/repo', tabID, (url) => loads.push(url));

    requestBrowserTabLoad('/repo', tabID, 'http://localhost:5173/');
    requestBrowserTabLoad('/other', tabID, 'http://localhost:5173/');
    expect(loads).toEqual(['http://localhost:5173/']);

    stop();
    requestBrowserTabLoad('/repo', tabID, 'http://localhost:5173/');
    expect(loads).toEqual(['http://localhost:5173/']);
  });

  test('a load request reloads a failed tab but leaves a working page alone', () => {
    const url = 'http://localhost:5173/';
    const failed = { kind: 'failed', url, code: -102, description: 'ERR_CONNECTION_REFUSED' } as const;
    const ready = { kind: 'ready', url, title: 'dev' } as const;
    const loading = { kind: 'loading', url } as const;

    expect(acceptsBrowserTabLoadRequest(failed, false)).toBe(true);
    // A page that worked and then failed shows the error, so it loads again.
    expect(acceptsBrowserTabLoadRequest(failed, true)).toBe(true);
    // Nothing shown yet: the first load is still going or never produced a page.
    expect(acceptsBrowserTabLoadRequest(loading, false)).toBe(true);
    expect(acceptsBrowserTabLoadRequest({ kind: 'idle' }, false)).toBe(true);

    expect(acceptsBrowserTabLoadRequest(ready, true)).toBe(false);
    expect(acceptsBrowserTabLoadRequest(loading, true)).toBe(false);
  });
});
