import { describe, expect, test } from 'bun:test';
import { refreshTrayStatusTargets } from './tray-status-refresh';

const targets = new Map([
  ['/repo-a', ['a']],
  ['/repo-b', ['b']],
  ['/repo-c', ['c']],
  ['/repo-d', ['d']],
]);

describe('refreshTrayStatusTargets', () => {
  test('does not poll any directory before OpenCode is ready', async () => {
    const calls: string[] = [];

    await refreshTrayStatusTargets({
      targets,
      isReady: () => false,
      fetchStatus: async (directory) => {
        calls.push(directory);
        return {};
      },
      applySnapshot: () => undefined,
    });

    expect(calls).toEqual([]);
  });

  test('reconciles ready directories with at most two requests in flight', async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const releases: Array<() => void> = [];
    const applied: string[] = [];

    const refresh = refreshTrayStatusTargets({
      targets,
      isReady: () => true,
      concurrency: 2,
      fetchStatus: async (directory) => {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        await new Promise<void>((resolve) => releases.push(resolve));
        inFlight -= 1;
        return { [directory]: { type: 'idle' } };
      },
      applySnapshot: (directory) => applied.push(directory),
    });

    await Promise.resolve();
    expect(inFlight).toBe(2);
    releases.splice(0).forEach((release) => release());
    await Promise.resolve();
    await Promise.resolve();
    expect(inFlight).toBe(2);
    releases.splice(0).forEach((release) => release());
    await refresh;

    expect(peakInFlight).toBe(2);
    expect(applied).toHaveLength(4);
  });

  test('preserves existing status when a directory fetch fails', async () => {
    const applied: string[] = [];

    await refreshTrayStatusTargets({
      targets: new Map([['/repo', ['a']]]),
      isReady: () => true,
      fetchStatus: async () => null,
      applySnapshot: (directory) => applied.push(directory),
    });

    expect(applied).toEqual([]);
  });
});
