import { describe, expect, test } from 'bun:test';

import { createTrayRuntimeGenerationGuard } from './useTraySync';

describe('tray runtime generation', () => {
  test('rejects an in-flight snapshot after the runtime changes', () => {
    let runtimeKey = 'runtime-a';
    const guard = createTrayRuntimeGenerationGuard(() => runtimeKey);
    const oldRequest = guard.capture();

    runtimeKey = 'runtime-b';
    guard.invalidate(runtimeKey);

    expect(guard.isCurrent(oldRequest)).toBe(false);
    expect(guard.isCurrent(guard.capture())).toBe(true);
  });

  test('invalidates same-key requests by generation as well as endpoint identity', () => {
    const guard = createTrayRuntimeGenerationGuard(() => 'runtime-a');
    const oldRequest = guard.capture();

    guard.invalidate('runtime-a');

    expect(guard.isCurrent(oldRequest)).toBe(false);
    expect(guard.isCurrent(guard.capture())).toBe(true);
  });
});
