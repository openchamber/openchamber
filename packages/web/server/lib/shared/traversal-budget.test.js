import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTraversalBudget } from './traversal-budget.js';

// The conformance probe matrix for the #1391 traversal-budget contract
// (phase 1, #1392). Each probe states one contract behaviour against
// the primitive alone; call-site migrations adopt the same probes when
// they move onto the budget.

// A directory-only tree — the #1332 probe shape: a results counter is
// vacuous here because nothing the walk returns ever increments it.
const dirTree = (depth, breadth) => {
  if (depth === 0) return {};
  const node = {};
  for (let i = 0; i < breadth; i += 1) {
    node[`d${i}`] = dirTree(depth - 1, breadth);
  }
  return node;
};

// A minimal DFS walk over a plain-object tree that consults the budget
// before descending, exactly as a real walk consults it before readdir.
const walkDirs = (tree, budget) => {
  let entered = 0;
  const stack = [{ node: tree, depth: 1 }];
  while (stack.length > 0) {
    const { node, depth } = stack.pop();
    if (!budget.visitDir(depth)) continue;
    entered += 1;
    for (const child of Object.values(node)) {
      stack.push({ node: child, depth: depth + 1 });
    }
  }
  return entered;
};

describe('createTraversalBudget', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires maxDirs as a positive integer', () => {
    expect(() => createTraversalBudget()).toThrow(RangeError);
    expect(() => createTraversalBudget({})).toThrow(RangeError);
    expect(() => createTraversalBudget({ maxDirs: 0 })).toThrow(RangeError);
    expect(() => createTraversalBudget({ maxDirs: 2.5 })).toThrow(RangeError);
    expect(() => createTraversalBudget({ maxDirs: '100' })).toThrow(RangeError);
  });

  it('stops a directory-only tree at maxDirs with truncated set', () => {
    const budget = createTraversalBudget({ maxDirs: 5 });
    // 1 + 3 + 9 = 13 directories in the tree; the walk may enter 5.
    const entered = walkDirs(dirTree(2, 3), budget);
    expect(entered).toBe(5);
    expect(budget.visitedDirs).toBe(5);
    expect(budget.truncated).toBe(true);
    expect(budget.exhausted).toBe(true);
    // No further consultations are allowed once the bound stops the walk.
    expect(budget.visitDir()).toBe(false);
  });

  it('completes a tree exactly at the bound with truncated unset', () => {
    const budget = createTraversalBudget({ maxDirs: 4 });
    // 1 + 3 = 4 directories: the walk consumes the bound exactly and
    // never consults again, so nothing was cut.
    const entered = walkDirs(dirTree(1, 3), budget);
    expect(entered).toBe(4);
    expect(budget.visitedDirs).toBe(4);
    expect(budget.truncated).toBe(false);
    expect(budget.exhausted).toBe(false);
  });

  it('stops on maxEntries independently of the directory bound', () => {
    const budget = createTraversalBudget({ maxDirs: 100, maxEntries: 3 });
    expect(budget.visitEntry()).toBe(true);
    expect(budget.visitEntry()).toBe(true);
    expect(budget.visitEntry()).toBe(true);
    expect(budget.visitEntry()).toBe(false);
    expect(budget.visitedEntries).toBe(3);
    expect(budget.truncated).toBe(true);
    // The entries bound consumed no directories: the directory
    // dimension still has its full allowance.
    expect(budget.visitedDirs).toBe(0);
    expect(budget.visitDir()).toBe(true);
    expect(budget.visitedDirs).toBe(1);
  });

  it('stops on maxDepth independently of the directory bound', () => {
    const budget = createTraversalBudget({ maxDirs: 100, maxDepth: 2 });
    expect(budget.visitDir(1)).toBe(true);
    expect(budget.visitDir(2)).toBe(true);
    // Past the depth bound: refused, and the refusal counts nothing.
    expect(budget.visitDir(3)).toBe(false);
    expect(budget.visitedDirs).toBe(2);
    expect(budget.truncated).toBe(true);
    // Shallower consultations are still allowed afterwards.
    expect(budget.visitDir(1)).toBe(true);
    expect(budget.visitedDirs).toBe(3);
  });

  it('counts directories reached through a followed link against the same budget', () => {
    const budget = createTraversalBudget({ maxDirs: 4 });
    // The root tree contributes 3 directories...
    expect(walkDirs(dirTree(1, 2), budget)).toBe(3);
    // ...and a followed link leads into an external tree whose
    // directories consult the same budget: only 1 more may be entered.
    expect(walkDirs(dirTree(1, 2), budget)).toBe(1);
    expect(budget.visitedDirs).toBe(4);
    expect(budget.truncated).toBe(true);
  });

  it('reports deadline exhaustion to an async caller', async () => {
    vi.useFakeTimers();
    const budget = createTraversalBudget({ maxDirs: 100, deadlineMs: 1_000 });
    await Promise.resolve();
    expect(budget.visitDir()).toBe(true);
    expect(budget.exhausted).toBe(false);
    vi.setSystemTime(Date.now() + 1_001);
    expect(budget.exhausted).toBe(true);
    expect(budget.visitDir()).toBe(false);
    expect(budget.truncated).toBe(true);
    // The refused consultation counted nothing.
    expect(budget.visitedDirs).toBe(1);
  });

  it('keeps answering stop after exhaustion with no counter drift', () => {
    const budget = createTraversalBudget({ maxDirs: 2, maxEntries: 1 });
    expect(budget.visitDir()).toBe(true);
    expect(budget.visitDir()).toBe(true);
    expect(budget.visitDir()).toBe(false);
    expect(budget.visitEntry()).toBe(true);
    expect(budget.visitEntry()).toBe(false);
    for (let i = 0; i < 5; i += 1) {
      expect(budget.visitDir()).toBe(false);
      expect(budget.visitEntry()).toBe(false);
    }
    expect(budget.visitedDirs).toBe(2);
    expect(budget.visitedEntries).toBe(1);
    expect(budget.truncated).toBe(true);
    expect(budget.exhausted).toBe(true);
  });
});
