import { beforeEach, describe, expect, test } from 'bun:test';

import {
  recordFileTreeDragStart,
  resetFileTreeDragClickState,
  shouldTreatFileTreeDragEndAsClick,
} from './fileTreeDragClick';

const dragEnd = (clientX: number, clientY: number, dropEffect = 'none') => ({
  clientX,
  clientY,
  dataTransfer: { dropEffect },
});

beforeEach(() => {
  resetFileTreeDragClickState();
});

describe('file tree drag-click fallback (#2368)', () => {
  test('a micro-drag that ends where it began is recovered as a click', () => {
    // Chromium starts a native drag after ~4px of pointer travel and then
    // suppresses the click event for the rest of the gesture. On macOS
    // trackpads a plain click routinely slips past that threshold, which is
    // the "clicking a folder does nothing" symptom of issue #2368.
    recordFileTreeDragStart({ clientX: 100, clientY: 200 });

    expect(shouldTreatFileTreeDragEndAsClick(dragEnd(102, 201))).toBe(true);
  });

  test('a zero-travel drag end is recovered as a click', () => {
    recordFileTreeDragStart({ clientX: 100, clientY: 200 });

    expect(shouldTreatFileTreeDragEndAsClick(dragEnd(100, 200))).toBe(true);
  });

  test('a drag released far from its origin is not a click', () => {
    recordFileTreeDragStart({ clientX: 100, clientY: 200 });

    expect(shouldTreatFileTreeDragEndAsClick(dragEnd(180, 230))).toBe(false);
  });

  test('slop boundary: within the radius is a click, beyond it is not', () => {
    recordFileTreeDragStart({ clientX: 100, clientY: 200 });
    expect(shouldTreatFileTreeDragEndAsClick(dragEnd(108, 208))).toBe(true);

    recordFileTreeDragStart({ clientX: 100, clientY: 200 });
    expect(shouldTreatFileTreeDragEndAsClick(dragEnd(109, 200))).toBe(false);
  });

  test('a drag dropped onto a target is never a click', () => {
    // Dragging a file into the chat input inserts an @mention; a completed
    // drop must not additionally toggle or open the row.
    recordFileTreeDragStart({ clientX: 100, clientY: 200 });

    expect(shouldTreatFileTreeDragEndAsClick(dragEnd(101, 200, 'copy'))).toBe(false);
  });

  test('a drag end without a recorded start is ignored', () => {
    expect(shouldTreatFileTreeDragEndAsClick(dragEnd(100, 200))).toBe(false);
  });

  test('the recorded origin is consumed by the first drag end', () => {
    recordFileTreeDragStart({ clientX: 100, clientY: 200 });

    expect(shouldTreatFileTreeDragEndAsClick(dragEnd(100, 200))).toBe(true);
    expect(shouldTreatFileTreeDragEndAsClick(dragEnd(100, 200))).toBe(false);
  });

  test('a missing dataTransfer still recovers a near-origin drag as a click', () => {
    recordFileTreeDragStart({ clientX: 100, clientY: 200 });

    expect(
      shouldTreatFileTreeDragEndAsClick({ clientX: 101, clientY: 201, dataTransfer: null }),
    ).toBe(true);
  });
});
