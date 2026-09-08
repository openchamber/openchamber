import { describe, expect, test } from 'bun:test';
import { installWebUpdate, waitForUpdateApplied } from './web-update';

describe('browser host updates', () => {
  test('keeps the native target version returned by the install request', async () => {
    const result = await installWebUpdate(async () => Response.json({
      success: true, updateOwner: 'electron-updater', version: '1.22.3', autoRestart: true,
    }));
    expect(result).toEqual({ success: true, autoRestart: true, target: { owner: 'electron', version: '1.22.3' } });
  });

  test('rejects a native success response without its target version', async () => {
    expect(await installWebUpdate(async () => Response.json({
      success: true, updateOwner: 'electron-updater',
    }))).toEqual({ success: false });
  });

  test('rejects malformed success instead of starting the reconnect loop', async () => {
    expect(await installWebUpdate(async () => Response.json({}))).toEqual({ success: false });
  });

  test('keeps native polling on the web host route until the target is installed', async () => {
    let requests = 0;
    const result = await waitForUpdateApplied({ owner: 'electron', version: '1.22.3' }, '1.22.2', {
      intervalMs: 1, maxWaitMs: 1000,
      fetchUpdate: async (url, init) => {
        expect(url).toBe('/api/openchamber/update-check?appType=web&reportUsage=false&updateStatus=true');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        requests += 1;
        // The old package feed can say no update while native installation is
        // still pending. That does not prove the requested version is running.
        return Response.json({ available: false, currentVersion: requests === 1 ? '1.22.2' : '1.22.3' });
      },
    });
    expect(requests).toBe(2);
    expect(result).toEqual({ status: 'applied' });
  });

  test('reports a rejected native restart without treating it as a transient disconnect', async () => {
    const result = await waitForUpdateApplied({ owner: 'electron', version: '1.22.3' }, '1.22.2', {
      fetchUpdate: async () => Response.json({
        code: 'DESKTOP_UPDATE_RESTART_FAILED', error: 'Signature rejected',
      }, { status: 503 }),
    });
    expect(result).toEqual({ status: 'failed', error: 'Signature rejected' });
  });

  test('does not accept authentication loss as native upgrade completion', async () => {
    const requests: string[] = [];
    const result = await waitForUpdateApplied({ owner: 'electron', version: '1.22.3' }, '1.22.2', {
      intervalMs: 1, maxWaitMs: 20,
      fetchUpdate: async (url) => {
        requests.push(String(url));
        return Response.json({ error: 'Unauthorized' }, { status: 401 });
      },
    });
    expect(result).toEqual({ status: 'timeout' });
    expect(requests).not.toContain('/health');
  });

  test('a blocked poll cannot extend the overall deadline', async () => {
    const result = await waitForUpdateApplied({ owner: 'electron', version: '1.22.3' }, '1.22.2', {
      maxWaitMs: 20,
      fetchUpdate: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
      }),
    });
    expect(result).toEqual({ status: 'timeout' });
  });

  test('preserves package-manager completion after a version change', async () => {
    const result = await waitForUpdateApplied({ owner: 'package-manager' }, '1.22.2', {
      fetchUpdate: async () => Response.json({ available: false, currentVersion: '1.22.3' }),
    });
    expect(result).toEqual({ status: 'applied' });
  });
});
