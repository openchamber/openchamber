import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { connectExternalOpenCodeUrl } from './external-url';
import type { ReadyResult } from './types';

describe('connectExternalOpenCodeUrl', () => {
  test('marks connected when ready check succeeds', async () => {
    let calls = 0;
    const readyCheck = async (): Promise<ReadyResult> => {
      calls += 1;
      return {
        ok: true,
        baseUrl: 'http://127.0.0.1:5555',
        elapsedMs: 12,
        attempts: 1,
        version: '1.18.8',
      };
    };

    const result = await connectExternalOpenCodeUrl(
      'http://127.0.0.1:5555/',
      {},
      5000,
      readyCheck,
    );

    assert.equal(calls, 1);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.version, '1.18.8');
      assert.equal(result.detectedPort, 5555);
    }
  });

  test('returns error when health check fails', async () => {
    const readyCheck = async (): Promise<ReadyResult> => ({
      ok: false,
      elapsedMs: 300,
      attempts: 3,
      version: null,
    });

    const result = await connectExternalOpenCodeUrl(
      'http://127.0.0.1:5555/',
      {},
      300,
      readyCheck,
    );

    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /not healthy/);
    }
  });
});
