import { describe, expect, test } from 'bun:test';
import { boundaryClipKeyframes, boundaryFadeInKeyframes } from './rowDisclosure';

describe('boundaryClipKeyframes', () => {
  test('reveals a row as the boundary passes over it', () => {
    // A 20px row at 40, under a boundary moving 20 → 100.
    expect(boundaryClipKeyframes(40, 20, 20, 100)).toEqual([
      { offset: 0, clipPath: 'inset(0 0 20px 0)' },
      { offset: 0.25, clipPath: 'inset(0 0 20px 0)' },
      { offset: 0.5, clipPath: 'inset(0 0 0px 0)' },
      { offset: 1, clipPath: 'inset(0 0 0px 0)' },
    ]);
  });

  test('hides a row as the boundary rises over it', () => {
    expect(boundaryClipKeyframes(40, 20, 100, 20)).toEqual([
      { offset: 0, clipPath: 'inset(0 0 0px 0)' },
      { offset: 0.5, clipPath: 'inset(0 0 0px 0)' },
      { offset: 0.75, clipPath: 'inset(0 0 20px 0)' },
      { offset: 1, clipPath: 'inset(0 0 20px 0)' },
    ]);
  });
});

describe('boundaryFadeInKeyframes', () => {
  test('starts the row right under the header as the motion starts', () => {
    // A 40px row at 20, the first under a boundary moving 20 → 100.
    expect(boundaryFadeInKeyframes(20, 40, 20, 100)).toEqual([
      { offset: 0, opacity: 0 },
      { offset: 0.25, opacity: 1 },
      { offset: 1, opacity: 1 },
    ]);
  });

  test('keeps a lower row clear until the boundary reaches it', () => {
    expect(boundaryFadeInKeyframes(60, 40, 20, 100)).toEqual([
      { offset: 0, opacity: 0 },
      { offset: 0.5, opacity: 0 },
      { offset: 0.75, opacity: 1 },
      { offset: 1, opacity: 1 },
    ]);
  });
});
