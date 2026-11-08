import { describe, expect, test } from 'bun:test';
import type { Active, ClientRect } from '@dnd-kit/core';
import { keepRowInList } from './rowDrag';

const rect = (top: number, height = 28): ClientRect => ({ top, bottom: top + height, left: 0, right: 240, width: 240, height });

const move = (y: number, x = 30) => keepRowInList({
  transform: { x, y, scaleX: 1, scaleY: 1 },
  // Picked up at 300 in a list from 100 to 700.
  active: { id: 'row', data: { current: {} }, rect: { current: { initial: rect(300), translated: null } } } satisfies Active,
  activatorEvent: null,
  activeNodeRect: null,
  containerNodeRect: null,
  draggingNodeRect: null,
  over: null,
  overlayNodeRect: null,
  scrollableAncestors: [],
  scrollableAncestorRects: [rect(100, 600)],
  windowRect: null,
});

describe('keepRowInList', () => {
  test('a lifted row moves straight up and down', () => {
    expect(move(50)).toMatchObject({ x: 0, y: 50 });
  });

  test('no further than the list, measured from where it was picked up', () => {
    expect(move(-500).y).toBe(-200);
    expect(move(500).y).toBe(372);
  });
});
