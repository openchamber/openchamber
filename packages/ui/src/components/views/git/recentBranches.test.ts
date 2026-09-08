import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { getRecentBranches, rememberRecentBranch } from './recentBranches';

class TestStorage implements Storage {
  #values = new Map<string, string>();

  get length(): number { return this.#values.size; }
  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(key); }
  setItem(key: string, value: string): void { this.#values.set(key, value); }
}

const originalLocalStorage = globalThis.localStorage;
let storage: TestStorage;

beforeEach(() => {
  storage = new TestStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
});

describe('recent Git branches', () => {
  test('persists a branch list for a later UI mount', () => {
    rememberRecentBranch('/repo', 'feature/one');
    rememberRecentBranch('/repo', 'feature/two');

    expect(getRecentBranches('/repo')).toEqual(['feature/two', 'feature/one']);
  });

  test('keeps only the five most recently used branches', () => {
    for (let index = 1; index <= 6; index += 1) {
      rememberRecentBranch('/repo', `feature/${index}`);
    }

    expect(getRecentBranches('/repo')).toEqual([
      'feature/6', 'feature/5', 'feature/4', 'feature/3', 'feature/2',
    ]);
  });
});
