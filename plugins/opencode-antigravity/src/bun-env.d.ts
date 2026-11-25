// Ambient Bun types the plugin and its tests use. bun-types is not a dependency, so only the members
// in use are declared (SR 3.3, 6.5).

declare namespace Bun {
  interface Server {
    readonly port: number;
    readonly hostname: string;
    /** Bun 1.4: resolves when the listener is closed. */
    stop(closeActiveConnections?: boolean): Promise<void>;
    /** Per-request idle timeout in seconds; 0 disables it for that request. */
    timeout(request: Request, seconds: number): void;
  }
  function serve(options: {
    hostname?: string;
    port?: number;
    /** Seconds, at most 255. */
    idleTimeout?: number;
    fetch: (req: Request, server: Server) => Response | Promise<Response>;
  }): Server;
}

declare module "bun:sqlite" {
  export interface Statement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  }
  export class Database {
    constructor(path: string, options?: { readonly?: boolean; create?: boolean; readwrite?: boolean });
    query(sql: string): Statement;
    prepare(sql: string): Statement;
    run(sql: string, ...params: unknown[]): unknown;
    close(): void;
  }
}

declare module "bun:test" {
  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toContain(expected: unknown): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toHaveLength(expected: number): void;
    toMatch(expected: RegExp | string): void;
    toThrow(expected?: unknown): void;
    toBeInstanceOf(constructor: unknown): void;
  }
  interface AsyncMatchers {
    toThrow(expected?: unknown): Promise<void>;
    toBe(expected: unknown): Promise<void>;
    toEqual(expected: unknown): Promise<void>;
  }
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  type TestFn = (name: string, fn: () => void | Promise<void>, timeoutMs?: number) => void;
  type DescribeFn = (name: string, fn: () => void) => void;
  export function describe(name: string, fn: () => void): void;
  export namespace describe {
    function skip(name: string, fn: () => void): void;
    function skipIf(condition: boolean): DescribeFn;
  }
  /** `timeoutMs` overrides the default 5 s per-test timeout. */
  export function test(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void;
  export namespace test {
    function skip(name: string, fn: () => void | Promise<void>, timeoutMs?: number): void;
    function skipIf(condition: boolean): TestFn;
  }
  export function expect(actual: unknown): Matchers & {
    not: Matchers;
    rejects: AsyncMatchers;
    resolves: AsyncMatchers;
  };
  export namespace expect {
    function any(constructor: unknown): unknown;
  }
}
