import { describe, expect, test } from 'bun:test';

import { nextDiskReadDelay } from './spacePlacesDisk';

describe('nextDiskReadDelay', () => {
  test('reads every few seconds while the host downloads the image', () => {
    expect(nextDiskReadDelay({ imagePulling: true, imageBytes: null }, 0)).toBe(3_000);
    expect(nextDiskReadDelay({ imagePulling: true, imageBytes: 0 }, 5)).toBe(3_000);
  });

  test('once the download ended, reads a few more times while the image has no size yet', () => {
    expect(nextDiskReadDelay({ imagePulling: false, imageBytes: 0 }, 0)).toBe(1_000);
    expect(nextDiskReadDelay({ imagePulling: false, imageBytes: 0 }, 4)).toBe(1_000);
    expect(nextDiskReadDelay({ imagePulling: false, imageBytes: 0 }, 5)).toBeNull();
  });

  test('stops once the image has a size or is absent', () => {
    expect(nextDiskReadDelay({ imagePulling: false, imageBytes: 1_647_000_000 }, 0)).toBeNull();
    expect(nextDiskReadDelay({ imagePulling: false, imageBytes: null }, 0)).toBeNull();
  });
});
