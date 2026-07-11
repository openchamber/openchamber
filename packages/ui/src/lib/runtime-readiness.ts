import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';

const DEFAULT_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 2_000, 2_000, 2_000] as const;

type RuntimeReadinessDependencies = {
  probe: (runtimeKey: string) => Promise<boolean>;
  wait: (delayMs: number) => Promise<void>;
  retryDelaysMs?: readonly number[];
};

type RuntimeReadinessCoordinator = {
  waitUntilReady: (runtimeKey: string) => Promise<void>;
  reset: (runtimeKey?: string) => void;
};

export const createRuntimeReadinessCoordinator = (
  dependencies: RuntimeReadinessDependencies,
): RuntimeReadinessCoordinator => {
  const inflightByRuntime = new Map<string, Promise<void>>();
  const readyRuntimes = new Set<string>();
  const runtimeGenerations = new Map<string, number>();
  let resetGeneration = 0;

  const getGeneration = (runtimeKey: string): string => (
    `${resetGeneration}:${runtimeGenerations.get(runtimeKey) ?? 0}`
  );

  const waitUntilReady = (runtimeKey: string): Promise<void> => {
    if (readyRuntimes.has(runtimeKey)) return Promise.resolve();
    const existing = inflightByRuntime.get(runtimeKey);
    if (existing) return existing;

    const retryDelaysMs = dependencies.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const generation = getGeneration(runtimeKey);
    const readiness = (async () => {
      for (const delayMs of retryDelaysMs) {
        if (getGeneration(runtimeKey) !== generation) return;
        if (delayMs > 0) await dependencies.wait(delayMs);
        if (getGeneration(runtimeKey) !== generation) return;
        if (await dependencies.probe(runtimeKey)) {
          if (getGeneration(runtimeKey) === generation) {
            readyRuntimes.add(runtimeKey);
          }
          return;
        }
      }
      throw new Error(`OpenCode did not become ready for runtime ${runtimeKey}`);
    })();
    inflightByRuntime.set(runtimeKey, readiness);
    void readiness.finally(() => {
      if (inflightByRuntime.get(runtimeKey) === readiness) {
        inflightByRuntime.delete(runtimeKey);
      }
    }).catch(() => {});
    return readiness;
  };

  return {
    waitUntilReady,
    reset: (runtimeKey) => {
      if (runtimeKey) {
        runtimeGenerations.set(runtimeKey, (runtimeGenerations.get(runtimeKey) ?? 0) + 1);
        inflightByRuntime.delete(runtimeKey);
        readyRuntimes.delete(runtimeKey);
        return;
      }
      resetGeneration += 1;
      inflightByRuntime.clear();
      readyRuntimes.clear();
    },
  };
};

const runtimeReadiness = createRuntimeReadinessCoordinator({
  probe: () => opencodeClient.checkHealth(),
  wait: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
});

export const waitForOpenCodeReadiness = (): Promise<void> => (
  runtimeReadiness.waitUntilReady(getRuntimeKey())
);

export const resetOpenCodeReadiness = (runtimeKey?: string): void => {
  runtimeReadiness.reset(runtimeKey);
};
