import { describe, expect, test } from 'bun:test';

import { canChangeReferenceBase } from './referenceBaseChange';

const changeable = { linked: false, baseChange: true, hasContext: true, hasOnChanged: true };

describe('the base pencil on the branch row', () => {
  test('is hidden only when the host explicitly denies branch write access', () => {
    expect(canChangeReferenceBase({ ...changeable, branchWriteAccess: false })).toBe(false);
    expect(canChangeReferenceBase({ ...changeable, branchWriteAccess: true })).toBe(true);
    expect(canChangeReferenceBase(changeable)).toBe(true);
  });

  test('is hidden without the host write, a read context, or a refresh to run', () => {
    expect(canChangeReferenceBase({ ...changeable, linked: true })).toBe(false);
    expect(canChangeReferenceBase({ ...changeable, baseChange: false })).toBe(false);
    expect(canChangeReferenceBase({ ...changeable, hasContext: false })).toBe(false);
    expect(canChangeReferenceBase({ ...changeable, hasOnChanged: false })).toBe(false);
  });
});
