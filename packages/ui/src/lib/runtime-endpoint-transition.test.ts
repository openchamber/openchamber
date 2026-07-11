import { describe, expect, test } from 'bun:test';

import { createRuntimeEndpointTransitionCoalescer } from './runtime-endpoint-transition';

describe('runtime endpoint transition coalescer', () => {
  test('applies only the final transition from a startup burst', async () => {
    const applied: string[] = [];
    const coalescer = createRuntimeEndpointTransitionCoalescer<string>((value) => {
      applied.push(value);
    }, 10);

    coalescer.schedule('local');
    coalescer.schedule('url-local');
    coalescer.schedule('host-a');
    coalescer.schedule('local-final');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(applied).toEqual(['local-final']);
    coalescer.cancel();
  });

  test('cancel prevents a pending transition after unmount', async () => {
    const applied: string[] = [];
    const coalescer = createRuntimeEndpointTransitionCoalescer<string>((value) => {
      applied.push(value);
    }, 10);

    coalescer.schedule('remote');
    coalescer.cancel();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(applied).toEqual([]);
  });
});
