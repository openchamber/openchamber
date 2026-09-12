import { describe, expect, test } from 'bun:test';

import { sortProjectsByOrder } from './projectSort';

const projects = [
  { id: 'beta', label: 'Beta', path: '/repos/beta', addedAt: 300, lastOpenedAt: 100 },
  { id: 'alpha', label: 'alpha', path: '/repos/alpha', addedAt: 100, lastOpenedAt: 300 },
  { id: 'gamma', label: null, path: '/repos/gamma', addedAt: 200, lastOpenedAt: 200 },
];

const ids = (list: ReadonlyArray<{ id: string }>): string[] => list.map((project) => project.id);

describe('sortProjectsByOrder', () => {
  // A label-less project compares by its whole path, so it sorts under '/'.
  // Both surfaces fill the label in before rendering; this only pins the
  // fallback down.
  test('orders by label case-insensitively, falling back to the path', () => {
    expect(ids(sortProjectsByOrder(projects, 'a-z', []))).toEqual(['gamma', 'alpha', 'beta']);
    expect(ids(sortProjectsByOrder(projects, 'z-a', []))).toEqual(['beta', 'alpha', 'gamma']);
  });

  test('puts the newest first for date-added and the most recently opened first for recent', () => {
    expect(ids(sortProjectsByOrder(projects, 'date-added', []))).toEqual(['beta', 'gamma', 'alpha']);
    expect(ids(sortProjectsByOrder(projects, 'recent', []))).toEqual(['alpha', 'gamma', 'beta']);
  });

  test('follows the manual order and keeps unlisted projects at the end', () => {
    expect(ids(sortProjectsByOrder(projects, 'manual', ['gamma', 'alpha']))).toEqual(['gamma', 'alpha', 'beta']);
  });

  test('leaves the input untouched', () => {
    const input = [...projects];
    sortProjectsByOrder(input, 'a-z', []);
    expect(ids(input)).toEqual(['beta', 'alpha', 'gamma']);
  });

  test('treats a missing timestamp as the oldest', () => {
    const withoutStamps = [{ id: 'none', path: '/repos/none' }, ...projects];
    expect(ids(sortProjectsByOrder(withoutStamps, 'recent', []))).toEqual(['alpha', 'gamma', 'beta', 'none']);
  });
});
