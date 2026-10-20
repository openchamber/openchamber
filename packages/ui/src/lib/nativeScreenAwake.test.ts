import { describe, expect, test } from 'bun:test';
import { createScreenAwakeWriter, setNativeScreenAwake } from './nativeScreenAwake';

describe('native screen-awake writer', () => {
  test('coalesces obsolete queued changes to the last requested mode', async () => {
    const calls: boolean[] = [];
    const write = createScreenAwakeWriter(async (enabled) => { calls.push(enabled); });
    const requests = [write(true), write(false), write(true), write(false)];
    await Promise.all(requests);
    expect(calls).toEqual([false]);
  });

  test('cleanup disables after an in-flight enable, never before it', async () => {
    const calls: boolean[] = [];
    const write = createScreenAwakeWriter(async (enabled) => {
      calls.push(enabled);
      if (enabled) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    const enable = write(true);
    await Promise.resolve();
    const disable = write(false);
    expect(calls).toEqual([true]);
    await Promise.all([enable, disable]);
    expect(calls).toEqual([true, false]);
  });

  test('a failed write does not strand later cleanup', async () => {
    const calls: boolean[] = [];
    const write = createScreenAwakeWriter(async (enabled) => {
      calls.push(enabled);
      if (enabled) throw new Error('Native operation failed');
    });
    await expect(write(true)).rejects.toThrow('Native operation failed');
    await write(false);
    expect(calls).toEqual([true, false]);
  });

  test('non-native runtimes never call an unavailable native plugin', async () => {
    await setNativeScreenAwake(true);
    await setNativeScreenAwake(false);
  });
});
