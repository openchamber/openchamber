/**
 * Local benchmark for worktree store optimizations from PR #1992.
 *
 * Run with:
 *   bun run packages/ui/src/lib/worktrees/worktreeManager.bench.ts
 *
 * This file is intentionally not auto-run on import; it only executes
 * the benchmark suite when launched as a script via `bun run`.
 */

import type { WorktreeMetadata } from '@/types/worktree';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const buildMap = (numProjects: number, worktreesPerProject: number): Map<string, WorktreeMetadata[]> => {
  const map = new Map<string, WorktreeMetadata[]>();
  for (let p = 0; p < numProjects; p++) {
    const projectDirectory = `/home/user/projects/project-${p}`;
    const worktrees: WorktreeMetadata[] = [];
    for (let w = 0; w < worktreesPerProject; w++) {
      worktrees.push({
        path: `${projectDirectory}/.worktrees/feat-${p}-${w}`,
        projectDirectory,
        branch: w === 0 ? 'main' : `feat-${p}-${w}`,
        label: w === 0 ? 'main' : `feat-${p}-${w}`,
        worktreeStatus: 'ready',
        headState: 'branch',
      });
    }
    map.set(projectDirectory, worktrees);
  }
  return map;
};

// ---------------------------------------------------------------------------
// Path-only (old) vs path+branch (new)
// ---------------------------------------------------------------------------

const oldEqualPathOnly = <T extends { path: string }>(
  a: Map<string, T[]>,
  b: Map<string, T[]>,
): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const existing = b.get(key);
    if (!existing || existing.length !== value.length) return false;
    for (let i = 0; i < value.length; i++) {
      if (value[i].path !== existing[i].path) return false;
    }
  }
  return true;
};

// ---------------------------------------------------------------------------
// Timing helpers
// ---------------------------------------------------------------------------

interface BenchResult {
  iterations: number;
  totalMs: number;
  nsPerOp: number;
  opsPerSec: number;
}

const measure = (
  iterations: number,
  warmupIterations: number,
  body: () => void,
): BenchResult => {
  // Warmup: let V8 inline, populate ICs, run a few GC cycles implicitly.
  for (let i = 0; i < warmupIterations; i++) {
    body();
  }
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    body();
  }
  const totalMs = performance.now() - start;
  const nsPerOp = (totalMs * 1_000_000) / iterations;
  const opsPerSec = 1_000_000_000 / nsPerOp;
  return { iterations, totalMs, nsPerOp, opsPerSec };
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const padLeft = (s: string, n: number): string => {
  if (s.length >= n) return s;
  return ' '.repeat(n - s.length) + s;
};

const formatOpsPerSec = (ops: number): string => {
  if (ops >= 1_000_000) return `${(ops / 1_000_000).toFixed(2)}M`;
  if (ops >= 1_000) return `${(ops / 1_000).toFixed(1)}K`;
  return Math.round(ops).toString();
};

// ---------------------------------------------------------------------------
// Benchmark suite
// ---------------------------------------------------------------------------

async function runBenchmarks(): Promise<void> {
  // Dynamic import so module-level side effects (subscriber registration)
  // are paid once and excluded from every measured call.
  const { worktreeMapsEqual } = await import('./worktreeManager');

  // ----- 1. worktreeMapsEqual throughput ---------------------------------
  console.log('=== worktreeMapsEqual throughput ===');
  console.log(`  ${padLeft('projects × worktrees', 22)}${padLeft('ns/op', 12)}${padLeft('ops/sec', 12)}`);

  const sizes: Array<[number, number]> = [
    [1, 1],
    [1, 10],
    [1, 100],
    [1, 1000],
    [10, 10],
    [20, 50],
    [50, 20],
  ];

  for (const [numProjects, worktreesPerProject] of sizes) {
    const a = buildMap(numProjects, worktreesPerProject);
    const b = buildMap(numProjects, worktreesPerProject);
    const result = measure(
      10_000,
      1_000,
      () => { worktreeMapsEqual(a, b); },
    );
    const label = `${numProjects} × ${worktreesPerProject}`;
    console.log(
      `  ${padLeft(label, 22)}${padLeft(Math.round(result.nsPerOp).toString(), 12)}${padLeft(formatOpsPerSec(result.opsPerSec), 12)}`,
    );
  }

  // Early-exit case: same shape, first project differs.
  {
    const numProjects = 50;
    const worktreesPerProject = 20;
    const a = buildMap(numProjects, worktreesPerProject);
    const b = buildMap(numProjects, worktreesPerProject);
    // Mutate the first project's first worktree path in b.
    const firstKey = a.keys().next().value as string;
    const bList = b.get(firstKey)!;
    bList[0] = { ...bList[0], path: '/home/user/projects/project-0/.worktrees/different-path' };
    const result = measure(
      10_000,
      1_000,
      () => { worktreeMapsEqual(a, b); },
    );
    const label = '50 × 20 (early-exit)';
    console.log(
      `  ${padLeft(label, 22)}${padLeft(Math.round(result.nsPerOp).toString(), 12)}${padLeft(formatOpsPerSec(result.opsPerSec), 12)}`,
    );
  }

  // ----- 2. Old (path-only) vs new (path+branch) -------------------------
  console.log('\n=== path-only vs path+branch (10 × 50) ===');
  {
    const a = buildMap(10, 50);
    const b = buildMap(10, 50);

    const oldResult = measure(
      100_000,
      5_000,
      () => { oldEqualPathOnly(a, b); },
    );
    const newResult = measure(
      100_000,
      5_000,
      () => { worktreeMapsEqual(a, b); },
    );
    const delta = newResult.nsPerOp - oldResult.nsPerOp;
    const deltaPct = (delta / oldResult.nsPerOp) * 100;
    const sign = delta >= 0 ? '+' : '';
    console.log(`  ${padLeft('path-only:', 18)}${padLeft(Math.round(oldResult.nsPerOp).toString(), 10)} ns/op`);
    console.log(`  ${padLeft('path+branch:', 18)}${padLeft(Math.round(newResult.nsPerOp).toString(), 10)} ns/op`);
    console.log(`  ${padLeft('delta:', 18)}${padLeft(`${sign}${Math.round(delta)}`, 10)} ns/op (${sign}${deltaPct.toFixed(1)}%)`);
  }

  // ----- 3. Subscriber stringify dedup -----------------------------------
  console.log('\n=== subscriber stringify (10 × 50) ===');
  {
    const map = buildMap(10, 50);

    // Cold: 2 stringifies per pass (what the old preSerialized-aware code did).
    const twiceResult = measure(
      10_000,
      1_000,
      () => {
        const a = JSON.stringify([...map.entries()]);
        const b = JSON.stringify([...map.entries()]);
        // Touch both to prevent dead-code elimination.
        if (a === b && a.length === 0) throw new Error('unreachable');
      },
    );
    // Hot: stringify once, compare string to cached value.
    const onceResult = measure(
      10_000,
      1_000,
      () => {
        const a = JSON.stringify([...map.entries()]);
        if (a === '' && a.length === 0) throw new Error('unreachable');
      },
    );
    const saved = twiceResult.nsPerOp - onceResult.nsPerOp;
    const savedPct = (saved / twiceResult.nsPerOp) * 100;
    console.log(`  ${padLeft('2× stringify:', 18)}${padLeft(Math.round(twiceResult.nsPerOp).toString(), 10)} ns/op`);
    console.log(`  ${padLeft('1× stringify:', 18)}${padLeft(Math.round(onceResult.nsPerOp).toString(), 10)} ns/op`);
    console.log(`  ${padLeft('saved:', 18)}${padLeft(Math.round(saved).toString(), 10)} ns/op (${savedPct.toFixed(1)}%)`);
  }

  // ----- 4. Content-compare guard ----------------------------------------
  console.log('\n=== content-compare guard (10 × 50) ===');
  {
    const a = buildMap(10, 50);
    const serialized = JSON.stringify([...a.entries()]);
    const result = measure(
      100_000,
      5_000,
      () => serialized === serialized,
    );
    console.log(`  ${padLeft('string compare:', 18)}${padLeft(Math.round(result.nsPerOp).toString(), 10)} ns/op`);
  }
}

if (import.meta.main) {
  await runBenchmarks();
}
