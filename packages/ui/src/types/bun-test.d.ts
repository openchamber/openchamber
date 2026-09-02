// Minimal type declarations for bun:test to satisfy tsc.
// Only the subset used by our test files is declared.

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function expect(value: unknown): {
    toEqual(expected: unknown): void;
    toBe(expected: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toThrow(expected?: string | RegExp | (new (...args: never[]) => unknown)): void;
    toContain(expected: unknown): void;
    toBeDefined(): void;
    rejects: {
      toThrow(expected?: string | RegExp | (new (...args: never[]) => unknown)): Promise<void>;
    };
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toHaveLength(expected: number): void;
    toBeInstanceOf(expected: unknown): void;
    not: {
      toEqual(expected: unknown): void;
      toBe(expected: unknown): void;
      toContain(expected: unknown): void;
      toBeNull(): void;
    };
  };
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  // Mock<T> matches the bun:test runtime mock: T (callable) plus spy methods.
  // Tests that need to swap implementations at runtime cast through `Mock<T>`.
  export interface Mock<T extends (...args: never[]) => unknown> {
    (...args: Parameters<T>): ReturnType<T>;
    mockImplementation(fn: T): Mock<T>;
    mockReturnValue(value: ReturnType<T>): Mock<T>;
    mockReset(): Mock<T>;
  }
  export function mock<T extends (...args: never[]) => unknown>(fn?: T): Mock<T>;
  export namespace mock {
    function module(moduleName: string, factory: () => Record<string, unknown>): void;
    function restore(): void;
  }
}
