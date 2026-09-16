import { describe, expect, test } from 'bun:test';

import {
  FALLBACK_GUEST_ICON,
  guestPackageIconSrc,
  isGuestPackageSvgIcon,
  resolveGuestIconName,
  resolveGuestToolIcon,
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
    expect(resolveGuestIconName('not-an-icon')).toBe('puzzle');
  });

  test('falls back for a package SVG path (rail uses iconSrc)', () => {
    expect(isGuestPackageSvgIcon('icon.svg')).toBe(true);
    expect(resolveGuestIconName('icon.svg')).toBe(FALLBACK_GUEST_ICON);
  });
});

describe('resolveGuestToolIcon', () => {
  const asset = (path: string) => `https://x${path}?t=1`;

  test('keeps a Remixicon name the sprite carries', () => {
    expect(resolveGuestToolIcon('tasks', 'checkbox-circle', asset)).toEqual({ icon: 'checkbox-circle' });
  });

  test('turns a package SVG path into an authenticated asset url', () => {
    expect(resolveGuestToolIcon('tasks', 'icons/tool.svg', asset))
      .toEqual({ icon: FALLBACK_GUEST_ICON, iconSrc: 'https://x/api/guests/tasks/icons/tool.svg?t=1' });
  });

  test('is null without an icon or for a name the sprite does not know', () => {
    expect(resolveGuestToolIcon('tasks', undefined, asset)).toBeNull();
    expect(resolveGuestToolIcon('tasks', 'not-an-icon', asset)).toBeNull();
    expect(resolveGuestToolIcon('tasks', 'linear', asset)).toBeNull();
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
