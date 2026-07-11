import { describe, expect, test } from 'bun:test';

import { createRuntimeReadinessCoordinator } from './runtime-readiness';

describe('runtime readiness coordinator', () => {
  test('coalesces concurrent readiness waits for one runtime', async () => {
    let probes = 0;
    let releaseProbe: (ready: boolean) => void = () => undefined;
    const coordinator = createRuntimeReadinessCoordinator({
      probe: () => {
        probes += 1;
        return new Promise<boolean>((resolve) => { releaseProbe = resolve; });
      },
      wait: async () => undefined,
    });

    const first = coordinator.waitUntilReady('runtime-a');
    const second = coordinator.waitUntilReady('runtime-a');

    expect(probes).toBe(1);
    releaseProbe(true);
    const result = await Promise.all([first, second]);
    expect(result).toEqual([undefined, undefined]);
    expect(probes).toBe(1);
  });

  test('isolates readiness work after the runtime key changes', async () => {
    const releases = new Map<string, (ready: boolean) => void>();
    const probes: string[] = [];
    const coordinator = createRuntimeReadinessCoordinator({
      probe: (runtimeKey) => {
        probes.push(runtimeKey);
        return new Promise<boolean>((resolve) => { releases.set(runtimeKey, resolve); });
      },
      wait: async () => undefined,
    });

    const oldRuntime = coordinator.waitUntilReady('runtime-a');
    const newRuntime = coordinator.waitUntilReady('runtime-b');

    expect(probes).toEqual(['runtime-a', 'runtime-b']);
    releases.get('runtime-b')?.(true);
    expect(await newRuntime).toBe(undefined);
    releases.get('runtime-a')?.(true);
    expect(await oldRuntime).toBe(undefined);
  });

  test('starts a fresh probe after one runtime readiness state is reset', async () => {
    const releases: Array<(ready: boolean) => void> = [];
    let probes = 0;
    const coordinator = createRuntimeReadinessCoordinator({
      probe: () => {
        probes += 1;
        return new Promise<boolean>((resolve) => { releases.push(resolve); });
      },
      wait: async () => undefined,
    });

    const stale = coordinator.waitUntilReady('runtime-a');
    coordinator.reset('runtime-a');
    const current = coordinator.waitUntilReady('runtime-a');

    expect(probes).toBe(2);
    releases[0]?.(true);
    expect(await stale).toBe(undefined);
    expect(coordinator.waitUntilReady('runtime-a')).toBe(current);
    releases[1]?.(true);
    expect(await current).toBe(undefined);
  });
});
