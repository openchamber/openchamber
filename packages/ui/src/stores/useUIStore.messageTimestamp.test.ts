import { beforeEach, describe, expect, test } from 'bun:test';

import { useUIStore, MESSAGE_TIMESTAMP_HYBRID_THRESHOLD_MIN } from './useUIStore';

describe('useUIStore message timestamp preference', () => {
  beforeEach(() => {
    useUIStore.getState().setMessageTimestampFormat('hybrid');
    useUIStore.getState().setMessageTimestampHybridThresholdMinutes(1440);
  });

  test('defaults to hybrid mode and 1440 minutes (1 day) threshold', () => {
    expect(useUIStore.getState().messageTimestampFormat).toBe('hybrid');
    expect(useUIStore.getState().messageTimestampHybridThresholdMinutes).toBe(1440);
  });

  test('setMessageTimestampFormat updates the mode', () => {
    useUIStore.getState().setMessageTimestampFormat('relative');
    expect(useUIStore.getState().messageTimestampFormat).toBe('relative');

    useUIStore.getState().setMessageTimestampFormat('hidden');
    expect(useUIStore.getState().messageTimestampFormat).toBe('hidden');

    useUIStore.getState().setMessageTimestampFormat('absolute');
    expect(useUIStore.getState().messageTimestampFormat).toBe('absolute');
  });

  test('setMessageTimestampHybridThresholdMinutes accepts valid integers >= min', () => {
    useUIStore.getState().setMessageTimestampHybridThresholdMinutes(1);
    expect(useUIStore.getState().messageTimestampHybridThresholdMinutes).toBe(1);

    useUIStore.getState().setMessageTimestampHybridThresholdMinutes(2880);
    expect(useUIStore.getState().messageTimestampHybridThresholdMinutes).toBe(2880);
  });

  test('setMessageTimestampHybridThresholdMinutes falls back to default for sub-min values', () => {
    useUIStore.getState().setMessageTimestampHybridThresholdMinutes(0);
    expect(useUIStore.getState().messageTimestampHybridThresholdMinutes).toBe(1440);
    expect(MESSAGE_TIMESTAMP_HYBRID_THRESHOLD_MIN).toBe(1);

    useUIStore.getState().setMessageTimestampHybridThresholdMinutes(-5);
    expect(useUIStore.getState().messageTimestampHybridThresholdMinutes).toBe(1440);
  });

  test('setMessageTimestampHybridThresholdMinutes floors fractional values', () => {
    useUIStore.getState().setMessageTimestampHybridThresholdMinutes(90.9);
    expect(useUIStore.getState().messageTimestampHybridThresholdMinutes).toBe(90);
  });

  test('setMessageTimestampHybridThresholdMinutes falls back for non-finite', () => {
    useUIStore.getState().setMessageTimestampHybridThresholdMinutes(Number.NaN);
    expect(useUIStore.getState().messageTimestampHybridThresholdMinutes).toBe(1440);
  });
});
