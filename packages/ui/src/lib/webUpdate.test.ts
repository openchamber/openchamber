import { describe, expect, test } from 'bun:test';

import { startWebUpdate, waitForWebUpdate } from './webUpdate';

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

describe('web update transaction polling', () => {
  test('starts a transaction from the accepted server response', async () => {
    const fetcher = async () => jsonResponse({
      accepted: true,
      transactionId: 'tx-1',
      currentVersion: '1.0.0',
      targetVersion: '1.1.0',
      restartManager: 'cli',
    }, 202);

    expect(await startWebUpdate(fetcher as never)).toEqual({
      accepted: true,
      transactionId: 'tx-1',
      currentVersion: '1.0.0',
      targetVersion: '1.1.0',
      restartManager: 'cli',
    });
  });

  test('succeeds only when health reports the exact target version', async () => {
    let healthChecks = 0;
    const fetcher = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/health') {
        healthChecks += 1;
        return jsonResponse({ openchamberVersion: healthChecks === 1 ? '1.0.0' : '1.1.0' });
      }
      return jsonResponse({
        id: 'tx-1',
        state: 'installing',
        currentVersion: '1.0.0',
        targetVersion: '1.1.0',
      });
    };

    expect(await waitForWebUpdate({
      transactionId: 'tx-1',
      targetVersion: '1.1.0',
      fetcher: fetcher as never,
      maxAttempts: 2,
      intervalMs: 0,
    })).toEqual({ outcome: 'healthy' });
  });

  test('does not mistake a healthy restored old server for success', async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      if (String(input) === '/health') return jsonResponse({ openchamberVersion: '1.0.0' });
      return jsonResponse({
        id: 'tx-1',
        state: 'recovered-old-version',
        currentVersion: '1.0.0',
        targetVersion: '1.1.0',
        errorCode: 'install-failed',
      });
    };

    expect(await waitForWebUpdate({
      transactionId: 'tx-1',
      targetVersion: '1.1.0',
      fetcher: fetcher as never,
      maxAttempts: 1,
      intervalMs: 0,
    })).toEqual({ outcome: 'recovered-old-version', errorCode: 'install-failed' });
  });

  test('does not use update availability as proof of installation', async () => {
    const requested: string[] = [];
    const fetcher = async (input: RequestInfo | URL) => {
      requested.push(String(input));
      if (String(input) === '/health') return jsonResponse({ openchamberVersion: '1.0.0' });
      return jsonResponse({
        id: 'tx-1',
        state: 'installing',
        currentVersion: '1.0.0',
        targetVersion: '1.1.0',
        available: false,
      });
    };

    expect(await waitForWebUpdate({
      transactionId: 'tx-1',
      targetVersion: '1.1.0',
      fetcher: fetcher as never,
      maxAttempts: 1,
      intervalMs: 0,
    })).toEqual({ outcome: 'timeout' });
    expect(requested).not.toContain('/api/openchamber/update-check');
  });

  test('cancels polling while waiting for the next attempt', async () => {
    const controller = new AbortController();
    const fetcher = async (input: RequestInfo | URL) => {
      if (String(input) === '/health') return jsonResponse({ openchamberVersion: '1.0.0' });
      return jsonResponse({
        id: 'tx-1',
        state: 'installing',
        currentVersion: '1.0.0',
        targetVersion: '1.1.0',
      });
    };

    const resultPromise = waitForWebUpdate({
      transactionId: 'tx-1',
      targetVersion: '1.1.0',
      fetcher: fetcher as never,
      maxAttempts: 10,
      intervalMs: 60_000,
      signal: controller.signal,
    });
    await Promise.resolve();
    controller.abort();

    expect(await resultPromise).toEqual({ outcome: 'cancelled' });
  });
});
