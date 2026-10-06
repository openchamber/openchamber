import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readMergeMethod, rememberMergeMethod } from './mergeMethodPreference';

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

describe('PR merge method preference', () => {
  test('starts as squash when nothing is stored', () => {
    expect(readMergeMethod()).toBe('squash');
  });

  test('returns the last remembered method for a later UI mount', () => {
    rememberMergeMethod('merge');
    expect(readMergeMethod()).toBe('merge');

    rememberMergeMethod('rebase');
    expect(readMergeMethod()).toBe('rebase');
  });

  test('ignores a stored value that is not a merge method', () => {
    storage.setItem('openchamber:pr-merge-method:v1', 'fast-forward');
    expect(readMergeMethod()).toBe('squash');
  });

  test('falls back to squash when storage throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('storage blocked'); },
    });

    rememberMergeMethod('merge');
    expect(readMergeMethod()).toBe('squash');
  });
});
