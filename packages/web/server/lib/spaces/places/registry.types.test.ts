import { describe, expect, expectTypeOf, it } from 'vitest';

import { createPlaceRegistry } from './registry.js';

describe('place registry types', () => {
  it('preserves implementation arguments and results', async () => {
    const operation = async (argument: string) => argument;
    const place = {
      id: 'typed',
      check: operation,
      create: operation,
      list: operation,
      exec: operation,
      execArgv: operation,
      connect: operation,
      stop: operation,
      start: operation,
      remove: operation,
      verify: operation,
    };
    const registry = createPlaceRegistry([place]);
    const result = registry.get('typed')?.check('preserved');
    expectTypeOf(result).toEqualTypeOf<Promise<string> | undefined>();
    expectTypeOf(registry.register({ ...place, id: 'another' })).toEqualTypeOf<typeof place>();
    expect(await result).toBe('preserved');
  });
});
