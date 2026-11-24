import { describe, expect, test } from 'bun:test';
import { storeKeyAfterConfigWrite } from './provider-key-writes';

const notRegistered = () => new Error('Integration not found: custom-provider');

describe('storeKeyAfterConfigWrite', () => {
  test('retries the key only while OpenCode has not registered the provider yet', async () => {
    const waits: number[] = [];
    let calls = 0;
    await storeKeyAfterConfigWrite(async () => {
      calls += 1;
      if (calls < 3) throw notRegistered();
    }, async (ms) => { waits.push(ms); });
    expect(calls).toBe(3);
    expect(waits).toEqual([250, 500]);

    let otherCalls = 0;
    await expect(storeKeyAfterConfigWrite(async () => {
      otherCalls += 1;
      throw new Error('Network down');
    }, async () => {})).rejects.toThrow('Network down');
    expect(otherCalls).toBe(1);
  });

  test('keeps the key waiting while the location starts its plugins', async () => {
    let elapsed = 0;
    await storeKeyAfterConfigWrite(async () => {
      if (elapsed < 5_600) throw notRegistered();
    }, async (ms) => { elapsed += ms; });
    expect(elapsed).toBeGreaterThanOrEqual(5_600);
  });

  test('gives up after about 30 seconds when OpenCode never registers the provider', async () => {
    let elapsed = 0;
    await expect(storeKeyAfterConfigWrite(async () => {
      throw notRegistered();
    }, async (ms) => { elapsed += ms; })).rejects.toThrow('Integration not found');
    expect(elapsed).toBeGreaterThanOrEqual(30_000);
    expect(elapsed).toBeLessThan(31_000);
  });
});
