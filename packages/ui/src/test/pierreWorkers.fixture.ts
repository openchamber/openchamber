import { plugin } from 'bun';
import { act, createElement, useLayoutEffect } from 'react';
import type { Root } from 'react-dom/client';
import type { WorkerPoolManager } from '@pierre/diffs/worker';

// Bun does not implement Vite's worker URL imports.
plugin({ name: 'pierre-fixture-worker-url', setup(build) {
  build.onLoad({ filter: /\?worker&url$/ }, () => ({
    contents: `export default ${JSON.stringify(import.meta.resolve('@pierre/diffs/worker/worker.js'))};`,
    loader: 'js',
  }));
} });

export async function startInlineDiffFixturePool(root: Root): Promise<WorkerPoolManager> {
  const { useWorkerPool } = await import('@/contexts/DiffWorkerProvider');
  let resolvePool: (pool: WorkerPoolManager) => void;
  const ready = new Promise<WorkerPoolManager>((resolve) => { resolvePool = resolve; });
  function CapturePool() {
    const pool = useWorkerPool('unified');
    useLayoutEffect(() => {
      if (pool) resolvePool(pool);
    }, [pool]);
    return null;
  }

  await act(async () => root.render(createElement(CapturePool)));
  return ready;
}
