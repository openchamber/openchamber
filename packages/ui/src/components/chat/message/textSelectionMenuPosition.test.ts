import { describe, expect, test } from 'bun:test';

import { getDesktopClampedMenuY } from './textSelectionMenuPosition';

describe('getDesktopClampedMenuY', () => {
  test('clamps negative and near-top anchors below the popup height', () => {
    expect(getDesktopClampedMenuY(-20, 800, 40)).toBe(48);
    expect(getDesktopClampedMenuY(47, 800, 40)).toBe(48);
  });

  test('preserves a normally positioned anchor', () => {
    expect(getDesktopClampedMenuY(300, 800, 40)).toBe(300);
  });

  test('clamps anchors at the bottom viewport boundary', () => {
    expect(getDesktopClampedMenuY(900, 800, 40)).toBe(792);
  });

  test('centers an oversized popup in a constrained viewport', () => {
    expect(getDesktopClampedMenuY(0, 40, 60)).toBe(50);
  });
});
