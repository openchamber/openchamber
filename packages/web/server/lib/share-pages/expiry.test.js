import { describe, expect, it } from 'vitest';

import { shareDeadline, workingDaysDeadline } from './expiry.js';

// Local-time constructors, so the cases hold in any time zone. 2026-11-13 is a Friday.
const at = (day, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

describe('workingDaysDeadline', () => {
  it('adds two days of weekday time to a start early in the week', () => {
    expect(workingDaysDeadline(at(9, 10))).toBe(at(11, 10));
  });

  it('skips the weekend: Thursday 09:00 ends on Monday 09:00', () => {
    expect(workingDaysDeadline(at(12, 9))).toBe(at(16, 9));
  });

  it('carries Friday 17:00 over the weekend to Tuesday 17:00', () => {
    expect(workingDaysDeadline(at(13, 17))).toBe(at(17, 17));
  });

  it('counts a weekend start from Monday 00:00', () => {
    expect(workingDaysDeadline(at(14, 0))).toBe(at(18, 0));
    expect(workingDaysDeadline(at(14, 15, 30))).toBe(at(18, 0));
    expect(workingDaysDeadline(at(15, 23, 59))).toBe(at(18, 0));
  });

  it('ends at the next working moment when the start is Friday midnight', () => {
    expect(workingDaysDeadline(at(13, 0))).toBe(at(17, 0));
  });
});

describe('shareDeadline', () => {
  it('defaults to two working days', () => {
    expect(shareDeadline(at(13, 17))).toBe(at(17, 17));
  });

  it('lets hours shorten the lifetime', () => {
    expect(shareDeadline(at(13, 17), 3)).toBe(at(13, 20));
  });

  it('never lets hours extend it past two working days', () => {
    expect(shareDeadline(at(13, 17), 24 * 7)).toBe(at(17, 17));
  });
});
