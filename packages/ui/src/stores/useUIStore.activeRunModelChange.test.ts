import { describe, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

describe('active-run model change preference', () => {
  test('defaults to applying model changes on the next message', () => {
    expect(useUIStore.getInitialState().activeRunModelChangeBehavior).toBe('next-message');
  });
});
