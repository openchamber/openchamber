import { beforeEach, describe, expect, test } from 'bun:test';

import { clearNativeSessionNotifications, hasNativeSessionNotifications } from './nativeNotifications';
import { switchRuntimeEndpoint } from './runtime-switch';

type Banner = { id: string; tag?: string; data: Record<string, string> };

let delivered: Banner[] = [];
let removed: unknown[][] = [];
let activeServerId: string | null = 'srv_a';
let readFailure: Error | null = null;

const load = async () => ({
  list: async () => {
    if (readFailure) throw readFailure;
    return delivered;
  },
  remove: async (banners: unknown[]) => {
    removed.push(banners);
  },
  activeServerId: () => activeServerId,
});

let nextNid = 1;
const banner = (sessionId: string, serverId = 'srv_a'): Banner => {
  const nid = String(nextNid++);
  return { id: '0', tag: `ready-${sessionId}`, data: { sessionId, serverId, 'openchamber.nid': nid } };
};
const pullRequestAlert = (): Banner => ({ id: '0', tag: 'pr-12', data: { serverId: 'srv_a', 'openchamber.nid': '99' } });
const seen = (shown: Banner) => ({ tag: shown.tag, id: shown.id, nid: shown.data['openchamber.nid'] });

describe('clearing native session notifications', () => {
  beforeEach(() => {
    delivered = [];
    removed = [];
    activeServerId = 'srv_a';
    readFailure = null;
  });

  test('removes the seen sessions\' banners from the active server and leaves the rest', async () => {
    const seenOne = banner('ses_seen');
    const seenTwo = banner('ses_also');
    delivered = [seenOne, banner('ses_other'), seenTwo, pullRequestAlert()];

    await clearNativeSessionNotifications(['ses_seen', 'ses_also'], load);

    expect(removed).toEqual([[seen(seenOne), seen(seenTwo)]]);
  });

  test('keeps a banner from another paired server that shares the session id', async () => {
    const own = banner('ses_shared', 'srv_a');
    delivered = [own, banner('ses_shared', 'srv_b')];

    await clearNativeSessionNotifications(['ses_shared'], load);

    expect(removed).toEqual([[seen(own)]]);
  });

  test('leaves banners alone when their server cannot be told', async () => {
    const shown = banner('ses_seen');
    const { serverId: _serverId, ...withoutServer } = shown.data;
    delivered = [{ ...shown, data: withoutServer }];
    await clearNativeSessionNotifications(['ses_seen'], load);

    delivered = [banner('ses_seen')];
    activeServerId = null;
    await clearNativeSessionNotifications(['ses_seen'], load);

    expect(removed).toEqual([]);
  });

  test('leaves a banner without its push id to the server\'s clear', async () => {
    const shown = banner('ses_seen');
    const { 'openchamber.nid': _nid, ...withoutNid } = shown.data;
    delivered = [{ ...shown, data: withoutNid }];

    await clearNativeSessionNotifications(['ses_seen'], load);

    expect(removed).toEqual([]);
  });

  test('tells whether any banner of the sessions is showing', async () => {
    delivered = [banner('ses_other', 'srv_b'), pullRequestAlert()];
    expect(await hasNativeSessionNotifications(['ses_other'], load)).toBe(false);

    delivered.push(banner('ses_other'));
    expect(await hasNativeSessionNotifications(['ses_other'], load)).toBe(true);
  });

  test('drops a clear whose server was switched away while the bridge loaded', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://a.example', runtimeKey: 'server:srv_a' });
    delivered = [banner('ses_shared', 'srv_b')];
    let finishLoad: () => void = () => {};
    const loading = new Promise<void>((resolve) => { finishLoad = resolve; });
    const deferredLoad = async () => {
      await loading;
      return load();
    };

    const clearing = clearNativeSessionNotifications(['ses_shared'], deferredLoad);
    const checking = hasNativeSessionNotifications(['ses_shared'], deferredLoad);
    switchRuntimeEndpoint({ apiBaseUrl: 'https://b.example', runtimeKey: 'server:srv_b' });
    activeServerId = 'srv_b';
    finishLoad();

    await clearing;
    expect(removed).toEqual([]);
    expect(await checking).toBe(false);
  });

  test('survives a list read that fails before registration completes', async () => {
    readFailure = new Error('registration not called');

    await clearNativeSessionNotifications(['ses_seen'], load);

    expect(removed).toEqual([]);
    expect(await hasNativeSessionNotifications(['ses_seen'], load)).toBe(false);
  });
});
