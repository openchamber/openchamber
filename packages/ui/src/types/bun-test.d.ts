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
    toThrow(expected?: string | RegExp): void;
    toContain(expected: unknown): void;
    toBeGreaterThan(expected: number): void;
    toBeLessThan(expected: number): void;
    toHaveLength(expected: number): void;
    not: {
      toEqual(expected: unknown): void;
      toBe(expected: unknown): void;
      toContain(expected: unknown): void;
    };
  };
}
