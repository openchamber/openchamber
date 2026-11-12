import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNotificationTriggerRuntime } from './runtime.js';

afterEach(() => vi.unstubAllGlobals());

describe('notification trigger delegated transport', () => {
  it('reads session ancestry and goal-settle names through the injected authenticated transport', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ data: { id: 'ses_1', title: 'Agent session', parentID: 'ses_parent' } }));
    const sendPushToAllUiSessions = vi.fn(async () => {});
    const runtime = createNotificationTriggerRuntime({
      buildOpenCodeUrl: (route) => `http://agent${route}`,
      getOpenCodeAuthHeaders: () => ({}), fetchImpl, sendPushToAllUiSessions,
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('raw fetch is forbidden'); }));
    await expect(runtime.isSubagentSession('ses_1', '/agent/repo')).resolves.toBe(true);
    await runtime.sendGoalSettlePush({ sessionId: 'ses_1', directory: '/agent/repo', status: 'complete', title: 'Done', body: 'Finished' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sendPushToAllUiSessions.mock.calls[0][0].data.sessionName).toBe('Agent session');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
