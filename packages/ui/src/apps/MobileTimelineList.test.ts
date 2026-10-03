import { describe, expect, test } from 'bun:test';

import { TIMELINE_PAGE_SIZE, revealNextTimelinePage } from './mobileTimelinePaging';

describe('revealNextTimelinePage', () => {
  test('reveals one more page while entries remain', () => {
    expect(revealNextTimelinePage(TIMELINE_PAGE_SIZE, 500)).toBe(TIMELINE_PAGE_SIZE * 2);
  });

  test('stops at the total so the end sentinel cannot loop', () => {
    const total = TIMELINE_PAGE_SIZE + 5;
    expect(revealNextTimelinePage(TIMELINE_PAGE_SIZE, total)).toBe(total);
    expect(revealNextTimelinePage(total, total)).toBe(total);
  });

  test('never returns a negative or shrinking count', () => {
    expect(revealNextTimelinePage(0, 10)).toBe(10);
    expect(revealNextTimelinePage(-5, 100)).toBe(TIMELINE_PAGE_SIZE);
  });
});
