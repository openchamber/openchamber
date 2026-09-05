import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { DesktopHost, HostProbeResult } from './desktopHosts';

let probeResults: Record<string, HostProbeResult> = {};
const probeCalls: string[] = [];
let probeGate: Promise<void> | null = null;

const desktopModule = await import('./desktopHosts');
mock.module('./desktopHosts', () => ({
  ...desktopModule,
  desktopLocalClientTokenGet: async () => 'local-token',
  desktopHostProbe: async (url: string) => {
    probeCalls.push(url);
    if (probeGate) await probeGate;
    return probeResults[url] ?? { status: 'unreachable', latencyMs: 0 };
  },
}));

const desktopShell = await import('@/lib/desktop');
mock.module('@/lib/desktop', () => ({
  ...desktopShell,
  isDesktopShell: () => true,
  isElectronShell: () => false,
}));

const {
  getDesktopHostStatusSnapshot,
  probeDesktopHosts,
  pruneDesktopHostStatuses,
  setDesktopHostStatus,
  subscribeDesktopHostStatuses,
} = await import('./desktopHostStatus');

const host = (id: string, url: string): DesktopHost => ({ id, label: id, url });

describe('desktop host statuses', () => {
  beforeEach(() => {
    probeResults = {};
    probeCalls.length = 0;
    probeGate = null;
    pruneDesktopHostStatuses([]);
    setDesktopHostStatus('local', { status: 'ok', latencyMs: 1 });
    pruneDesktopHostStatuses([]);
  });

  test('a probe replaces the previous value instead of blanking it first', async () => {
    setDesktopHostStatus('remote', { status: 'ok', latencyMs: 12 });
    probeResults['https://remote.example'] = { status: 'ok', latencyMs: 40 };

    const seen: Array<string | undefined> = [];
    const unsubscribe = subscribeDesktopHostStatuses(() => {
      seen.push(getDesktopHostStatusSnapshot().byHostId.remote?.status);
    });
    await probeDesktopHosts([host('remote', 'https://remote.example')]);
    unsubscribe();

    // Every published snapshot during the run still carried a status; the row
    // never falls back to "Checking" while a quiet refresh is running.
    expect(seen.every((status) => status !== undefined)).toBe(true);
    expect(getDesktopHostStatusSnapshot().byHostId.remote?.latencyMs).toBe(40);
  });

  test('a fast host is published while a slow one is still in flight', async () => {
    probeResults['https://fast.example'] = { status: 'ok', latencyMs: 5 };
    probeResults['https://slow.example'] = { status: 'ok', latencyMs: 900 };
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => { releaseSlow = resolve; });
    probeGate = slowGate;

    const run = probeDesktopHosts([host('fast', 'https://fast.example'), host('slow', 'https://slow.example')]);
    await Promise.resolve();
    expect(getDesktopHostStatusSnapshot().isProbing).toBe(true);

    releaseSlow();
    await run;

    expect(getDesktopHostStatusSnapshot().byHostId.fast?.status).toBe('ok');
    expect(getDesktopHostStatusSnapshot().byHostId.slow?.status).toBe('ok');
    expect(getDesktopHostStatusSnapshot().isProbing).toBe(false);
  });

  test('pruning keeps local and every configured instance, and forgets the rest', () => {
    setDesktopHostStatus('kept', { status: 'ok', latencyMs: 3 });
    setDesktopHostStatus('removed', { status: 'ok', latencyMs: 4 });

    pruneDesktopHostStatuses(['kept']);

    const { byHostId } = getDesktopHostStatusSnapshot();
    expect(byHostId.kept?.status).toBe('ok');
    expect(byHostId.local?.status).toBe('ok');
    expect(byHostId.removed).toBe(undefined);
  });

  test('a snapshot is a new object per change so subscribers re-render', () => {
    const before = getDesktopHostStatusSnapshot();
    setDesktopHostStatus('remote', { status: 'auth', latencyMs: 0 });

    expect(getDesktopHostStatusSnapshot()).not.toBe(before);
    expect(before.byHostId.remote).toBe(undefined);
  });

  test('a slow older run cannot overwrite a newer result', async () => {
    // Startup warm-up, opening the switcher and the refresh button all probe;
    // whichever finishes last must not be whichever started first.
    probeResults['https://remote.example'] = { status: 'unreachable', latencyMs: 0 };
    let releaseSlow!: () => void;
    probeGate = new Promise<void>((resolve) => { releaseSlow = resolve; });

    const slowRun = probeDesktopHosts([host('remote', 'https://remote.example')]);
    await Promise.resolve();

    probeGate = null;
    probeResults['https://remote.example'] = { status: 'ok', latencyMs: 30 };
    await probeDesktopHosts([host('remote', 'https://remote.example')]);
    expect(getDesktopHostStatusSnapshot().byHostId.remote?.status).toBe('ok');

    releaseSlow();
    await slowRun;

    expect(getDesktopHostStatusSnapshot().byHostId.remote?.status).toBe('ok');
    expect(getDesktopHostStatusSnapshot().byHostId.remote?.latencyMs).toBe(30);
  });

  test('a status recorded by the switch flow outranks a probe already running', async () => {
    probeResults['https://remote.example'] = { status: 'unreachable', latencyMs: 0 };
    let releaseSlow!: () => void;
    probeGate = new Promise<void>((resolve) => { releaseSlow = resolve; });

    const slowRun = probeDesktopHosts([host('remote', 'https://remote.example')]);
    await Promise.resolve();
    setDesktopHostStatus('remote', { status: 'ok', latencyMs: 7, via: 'relay' });

    releaseSlow();
    await slowRun;

    expect(getDesktopHostStatusSnapshot().byHostId.remote?.status).toBe('ok');
  });
});
