/**
 * Reproduction script for issue #2173:
 * `findBestProjectDirectoryMatch` blocks the renderer main thread
 * due to redundant normalizePath calls inside the hot loop.
 *
 * This replicates the exact code paths from the sidebar hooks
 * and demonstrates the O(S × P × N) scaling with realistic data.
 */

import { normalizePath } from './src/lib/pathNormalization';

// ── Replicate the exact functions from utils.tsx ─────────────────

const isPathWithinProject = (directory?: string | null, projectPath?: string | null): boolean => {
  const normalizedDirectory = normalizePath(directory);
  const normalizedProjectPath = normalizePath(projectPath);
  if (!normalizedDirectory || !normalizedProjectPath) return false;
  if (normalizedDirectory === normalizedProjectPath) return true;
  if (normalizedProjectPath === '/') return normalizedDirectory.startsWith('/');
  return normalizedDirectory.startsWith(`${normalizedProjectPath}/`);
};

const findBestProjectDirectoryMatch = (
  value: string | null,
  knownDirectories?: Iterable<string>,
): string | null => {
  if (!value || !knownDirectories) return null;
  let bestMatch: string | null = null;
  for (const candidate of knownDirectories) {
    const normalizedCandidate = normalizePath(candidate);
    if (!normalizedCandidate || !isPathWithinProject(value, normalizedCandidate)) continue;
    if (!bestMatch || normalizedCandidate.length > bestMatch.length) {
      bestMatch = normalizedCandidate;
    }
  }
  return bestMatch;
};

type Session = { id: string; directory?: string | null; project?: { worktree?: string | null } | null };

const isSessionRelatedToProject = (
  session: Session,
  projectRoot: string,
  validDirectories?: Set<string>,
  knownDirectories?: Iterable<string>,
): boolean => {
  const sessionDirectory = normalizePath(session.directory ?? null);
  const projectWorktree = normalizePath(session.project?.worktree ?? null);
  const resolvedDirectory = sessionDirectory ?? projectWorktree;
  if (resolvedDirectory && validDirectories?.has(resolvedDirectory)) return true;
  if (!resolvedDirectory) return false;
  const bestMatch = findBestProjectDirectoryMatch(resolvedDirectory, knownDirectories);
  if (bestMatch) return validDirectories ? validDirectories.has(bestMatch) : bestMatch === projectRoot;
  return resolvedDirectory === projectRoot || resolvedDirectory.startsWith(`${projectRoot}/`);
};

// ── Data generation ──────────────────────────────────────────────

const generateProjects = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ normalizedPath: `/home/user/projects/project-${i}` }));

const generateWorktrees = (projectPath: string, count: number) =>
  Array.from({ length: count }, (_, i) => ({ path: `${projectPath}-worktree-${i}` }));

const buildWorktreeMap = (projects: { normalizedPath: string }[], wpp: number) => {
  const map = new Map<string, { path: string }[]>();
  for (const p of projects) map.set(p.normalizedPath, generateWorktrees(p.normalizedPath, wpp));
  return map;
};

const generateSessions = (count: number, projects: { normalizedPath: string }[], wpp: number): Session[] => {
  const allPaths: string[] = [];
  for (const p of projects) {
    allPaths.push(p.normalizedPath);
    for (let w = 0; w < wpp; w++) allPaths.push(`${p.normalizedPath}-worktree-${w}`);
  }
  return Array.from({ length: count }, (_, i) => ({
    id: `session_${i}`,
    directory: i < count * 0.9 ? allPaths[i % allPaths.length] : null,
    project: i < count * 0.1 ? { worktree: null } : undefined,
  }));
};

const buildKnownDirectories = (projects: { normalizedPath: string }[], worktreeMap: Map<string, { path: string }[]>) => {
  const dirs = new Set<string>();
  for (const p of projects) dirs.add(p.normalizedPath);
  for (const worktrees of worktreeMap.values())
    for (const w of worktrees) {
      const n = normalizePath(w.path);
      if (n) dirs.add(n);
    }
  return dirs;
};

// ── Benchmark helpers ────────────────────────────────────────────

const benchmark = (label: string, fn: () => void, iterations: number = 5): number => {
  fn(); // warmup
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  const avg = (performance.now() - start) / iterations;
  console.log(`  ${label}: avg ${avg.toFixed(1)}ms over ${iterations} runs`);
  return avg;
};

// ── Counting normalizePath calls ─────────────────────────────────
// We can't instrument the real normalizePath without modifying it,
// so we estimate: each isSessionRelatedToProject call does
//   2 normalizePath (session dir + worktree) + N * 3 normalizePath (per candidate)
// where N = known directories count.

function estimateNormalizeCalls(
  label: string,
  projects: number,
  worktreesPerProject: number,
  sessions: number,
) {
  const knownDirs = projects + projects * worktreesPerProject;
  // isSessionRelatedToProject per project × session
  // calls = P × S × (2 outer normalize + knownDirs × 3 inner normalize)
  const callsPer = 2 + knownDirs * 3;
  const total = projects * sessions * callsPer;
  console.log(`  [estimate] ${label}: ~${total.toLocaleString()} normalizePath calls (${knownDirs} known dirs, ${callsPer} per call)`);
}

console.log('\n══════════════════════════════════════════════════════');
console.log('  Reproduction: Performance issue #2173');
console.log('  Redundant normalizePath in findBestProjectDirectoryMatch');
console.log('══════════════════════════════════════════════════════════\n');

// ── Scenario A: 10 projects × 5 worktrees × 500 sessions ──────
{
  console.log('┌─ Scenario A: 10 projects, 5 worktrees each, 500 sessions');
  console.log('│  (single consumer — like useProjectSessionLists)\n');

  const projects = generateProjects(10);
  const worktreeMap = buildWorktreeMap(projects, 5);
  const sessions = generateSessions(500, projects, 5);
  const knownDirs = buildKnownDirectories(projects, worktreeMap);

  estimateNormalizeCalls('Scenario A', 10, 5, 500);

  const runOnce = () => {
    for (const project of projects) {
      const wf = worktreeMap.get(project.normalizedPath) ?? [];
      const validDirs = new Set([
        project.normalizedPath,
        ...wf.map((m) => normalizePath(m.path) ?? m.path).filter(Boolean),
      ]);
      for (const s of sessions) isSessionRelatedToProject(s, project.normalizedPath, validDirs, knownDirs);
    }
  };

  const avg = benchmark('isSessionRelatedToProject loop (1 consumer)', runOnce, 5);
  console.log(`  => ${avg >= 200 ? '🔴 BLOCKING' : avg >= 50 ? '🟡 SLOW' : '🟢 OK'} (thresholds: >200ms blocking, >50ms slow)\n`);
}

// ── Scenario B: 20 projects × 10 worktrees × 1000 sessions ─────
{
  console.log('┌─ Scenario B: 20 projects, 10 worktrees each, 1000 sessions');
  console.log('│  (single consumer — like useProjectSessionLists)\n');

  const projects = generateProjects(20);
  const worktreeMap = buildWorktreeMap(projects, 10);
  const sessions = generateSessions(1000, projects, 10);
  const knownDirs = buildKnownDirectories(projects, worktreeMap);

  estimateNormalizeCalls('Scenario B', 20, 10, 1000);

  const runOnce = () => {
    for (const project of projects) {
      const wf = worktreeMap.get(project.normalizedPath) ?? [];
      const validDirs = new Set([
        project.normalizedPath,
        ...wf.map((m) => normalizePath(m.path) ?? m.path).filter(Boolean),
      ]);
      for (const s of sessions) isSessionRelatedToProject(s, project.normalizedPath, validDirs, knownDirs);
    }
  };

  const avg = benchmark('isSessionRelatedToProject loop (1 consumer)', runOnce, 5);
  console.log(`  => ${avg >= 200 ? '🔴 BLOCKING' : avg >= 50 ? '🟡 SLOW' : '🟢 OK'}`);
  console.log(`  Note: 3 sidebar hooks run this simultaneously via different effects`);
  console.log(`  => Estimated total: ${(avg * 3).toFixed(0)}ms across all consumers\n`);
}

// ── Scenario C: 15 projects × 8 worktrees × 800 sessions ──────
// (more moderate, shows the O(N²) scaling)
{
  console.log('┌─ Scenario C: 15 projects, 8 worktrees each, 800 sessions');
  console.log('│  (single consumer — like useArchivedAutoFolders)\n');

  const projects = generateProjects(15);
  const worktreeMap = buildWorktreeMap(projects, 8);
  const sessions = generateSessions(800, projects, 8);
  const knownDirs = buildKnownDirectories(projects, worktreeMap);

  estimateNormalizeCalls('Scenario C', 15, 8, 800);

  const runOnce = () => {
    for (const project of projects) {
      const wf = worktreeMap.get(project.normalizedPath) ?? [];
      const validDirs = new Set([
        project.normalizedPath,
        ...wf.map((m) => normalizePath(m.path) ?? m.path).filter(Boolean),
      ]);
      for (const s of sessions) isSessionRelatedToProject(s, project.normalizedPath, validDirs, knownDirs);
    }
  };

  const avg = benchmark('isSessionRelatedToProject loop (1 consumer)', runOnce, 5);
  console.log(`  => ${avg >= 200 ? '🔴 BLOCKING' : avg >= 50 ? '🟡 SLOW' : '🟢 OK'}\n`);
}

// ── Micro-benchmarks to pinpoint the overhead ──────────────────
console.log('\n┌─ Micro-benchmarks\n');

// Cost of single normalizePath
{
  const paths = Array.from({ length: 10000 }, (_, i) =>
    `/some/very/long/path/with/many/segments/for/testing/purposes/file-${i}.ts`,
  );
  benchmark('normalizePath × 10000', () => {
    for (const p of paths) normalizePath(p);
  }, 20);
}

// Cost of findBestProjectDirectoryMatch loop with redundant normalize
{
  const target = '/home/user/projects/project-5';
  const knownDirs = Array.from({ length: 200 }, (_, i) =>
    i === 5 ? target : `/home/user/projects/project-${i}`,
  );
  const knownSet = new Set(knownDirs);

  benchmark('findBestProjectDirectoryMatch with 200 candidates', () => {
    findBestProjectDirectoryMatch(target, knownSet);
  }, 50);
}

// Cost with already-normalized knownDirectories (the fix)
{
  const findBestProjectDirectoryMatchFixed = (
    value: string | null,
    knownDirectories?: Iterable<string>,
  ): string | null => {
    if (!value || !knownDirectories) return null;
    let bestMatch: string | null = null;
    for (const candidate of knownDirectories) {
      // No normalizePath — knownDirectories is already normalized
      if (!candidate || !isPathWithinProject(value, candidate)) continue;
      if (!bestMatch || candidate.length > bestMatch.length) bestMatch = candidate;
    }
    return bestMatch;
  };

  const target = '/home/user/projects/project-5';
  const knownDirs = Array.from({ length: 200 }, (_, i) =>
    i === 5 ? target : `/home/user/projects/project-${i}`,
  );
  const knownSet = new Set(knownDirs);

  benchmark('findBestProjectDirectoryMatch (FIXED, no inner normalize) with 200 candidates', () => {
    findBestProjectDirectoryMatchFixed(target, knownSet);
  }, 50);
}

// ── Summary ────────────────────────────────────────────────────
console.log('\n══════════════════════════════════════════════════════');
console.log('  SUMMARY');
console.log('══════════════════════════════════════════════════════\n');
console.log('Root cause: redundant normalizePath calls in the hot loop.');
console.log('');
console.log('In findBestProjectDirectoryMatch (line 134 of utils.tsx):');
console.log('  const normalizedCandidate = normalizePath(candidate);');
console.log('  // ^^ redundant — knownDirectories was built from already-normalized paths');
console.log('  if (!normalizedCandidate || !isPathWithinProject(value, normalizedCandidate))');
console.log('                                     ^^ normalizes both args AGAIN');
console.log('');
console.log('Each isSessionRelatedToProject call does:');
console.log('  2 normalizePath (outer: session dir + worktree)');
console.log('  + N × 3 normalizePath (inner: 1 for candidate + 2 in isPathWithinProject)');
console.log('  = 2 + 3N normalizePath calls');
console.log('  = ~4,502 calls for 20 projects × 10 worktrees (= 200 known dirs)');
console.log('');
console.log('Multiplied by P projects × S sessions × 3 hooks:');
console.log('  Total ≈ 3 × P × S × (2 + 3N) normalizePath calls');
console.log('');
console.log('For 20 projects, 10 worktrees each, 1000 sessions:');
console.log('  knownDirs = 20 + 200 = 220');
console.log('  calls per isSessionRelatedToProject = 2 + 220×3 = 662');
console.log('  total normalizePath calls = 3 × 20 × 1000 × 662 = ~39.7 million!');
