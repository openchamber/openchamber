import { beforeEach, describe, expect, test } from 'bun:test';
import {
  ascendingRuntimeId,
  observeRuntimeResponseDate,
  resetRuntimeIdStateForTests,
} from './runtime-id';

const decodeTimestamp = (id: string): number => {
  const sortable = BigInt(`0x${id.slice(4, 16)}`);
  return Number(sortable / BigInt(0x1000));
};

const encodedTimestamp = (timestamp: number): number => timestamp % 2 ** 36;

describe('runtime-aware ascending IDs', () => {
  beforeEach(() => {
    resetRuntimeIdStateForTests();
  });

  test('uses the server response clock when the client clock is in the future', () => {
    const serverTime = Date.parse('2026-07-25T12:00:00.000Z');
    const clientTime = serverTime + 80_000;

    observeRuntimeResponseDate('runtime-a', new Response(null, {
      headers: { Date: new Date(serverTime).toUTCString() },
    }), clientTime, 1_000);

    const id = ascendingRuntimeId('msg', 'runtime-a', clientTime + 250, 1_250);
    expect(decodeTimestamp(id)).toBe(encodedTimestamp(serverTime + 250));
    expect(decodeTimestamp(id)).toBeLessThan(encodedTimestamp(clientTime));
  });

  test('keeps clock samples and monotonic ID state isolated by runtime', () => {
    const clientTime = Date.parse('2026-07-25T12:01:20.000Z');
    const serverTime = clientTime - 80_000;

    observeRuntimeResponseDate('runtime-a', new Response(null, {
      headers: { Date: new Date(serverTime).toUTCString() },
    }), clientTime, 2_000);

    const synchronized = ascendingRuntimeId('msg', 'runtime-a', clientTime, 2_000);
    const unsynchronized = ascendingRuntimeId('msg', 'runtime-b', clientTime, 2_000);

    expect(decodeTimestamp(synchronized)).toBe(encodedTimestamp(serverTime));
    expect(decodeTimestamp(unsynchronized)).toBe(encodedTimestamp(clientTime));
  });

  test('ignores missing or malformed response dates', () => {
    const clientTime = Date.parse('2026-07-25T12:01:20.000Z');

    observeRuntimeResponseDate('runtime-a', new Response(null), clientTime, 3_000);
    observeRuntimeResponseDate('runtime-a', new Response(null, {
      headers: { Date: 'not-a-date' },
    }), clientTime, 3_000);
    observeRuntimeResponseDate('runtime-a', new Response(null, {
      headers: { Date: '2026-07-25T12:00:00.000Z' },
    }), clientTime, 3_000);

    expect(decodeTimestamp(ascendingRuntimeId('msg', 'runtime-a', clientTime, 3_000))).toBe(encodedTimestamp(clientTime));
  });

  test('keeps IDs ascending when a later response has an older rounded date', () => {
    const firstServerTime = Date.parse('2026-07-25T12:00:01.000Z');

    observeRuntimeResponseDate('runtime-a', new Response(null, {
      headers: { Date: new Date(firstServerTime).toUTCString() },
    }), firstServerTime + 80_000, 4_000);
    const first = ascendingRuntimeId('msg', 'runtime-a', firstServerTime + 80_100, 4_100);

    observeRuntimeResponseDate('runtime-a', new Response(null, {
      headers: { Date: new Date(firstServerTime - 1_000).toUTCString() },
    }), firstServerTime + 80_200, 4_200);
    const second = ascendingRuntimeId('msg', 'runtime-a', firstServerTime + 80_200, 4_200);

    expect(second > first).toBe(true);
  });
});
