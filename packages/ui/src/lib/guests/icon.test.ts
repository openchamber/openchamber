import { describe, expect, test } from 'bun:test';

import {
  FALLBACK_GUEST_ICON,
  guestPackageIconSrc,
  isGuestPackageSvgIcon,
  resolveGuestIconName,
} from './icon.ts';

describe('resolveGuestIconName', () => {
  test('keeps a Remixicon name from the host sprite', () => {
    expect(resolveGuestIconName('git-merge')).toBe('git-merge');
    expect(resolveGuestIconName('task')).toBe('task');
    const gitlab = { icon: 'gitlab' };
    expect(resolveGuestIconName(gitlab.icon)).toBe('gitlab');
  });

  test('falls back for a host product mark', () => {
    expect(resolveGuestIconName('linear')).toBe(FALLBACK_GUEST_ICON);
    expect(resolveGuestIconName('openchamber')).toBe(FALLBACK_GUEST_ICON);
  });

  test('falls back when the sprite has no such Remixicon', () => {
    expect(resolveGuestIconName('not-an-icon')).toBe(FALLBACK_GUEST_ICON);
  });

  test('falls back for a package SVG path (rail uses iconSrc)', () => {
    expect(isGuestPackageSvgIcon('icon.svg')).toBe(true);
    expect(resolveGuestIconName('icon.svg')).toBe(FALLBACK_GUEST_ICON);
  });
});

describe('guestPackageIconSrc', () => {
  test('builds an authenticated asset url for package SVGs', () => {
    expect(guestPackageIconSrc('hello', 'icon.svg', (path) => `https://x${path}?t=1`))
      .toBe('https://x/api/guests/hello/icon.svg?t=1');
  });

  test('skips Remixicon names', () => {
    expect(guestPackageIconSrc('gitlab', 'gitlab', (path) => path)).toBe(undefined);
  });
});
