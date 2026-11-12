import { describe, expect, test } from 'bun:test';

import {
  compareOpenChamberVersions,
  hostMeetsOpenChamberEngine,
  openChamberEngineMinimum,
  parseOpenChamberVersion,
} from './host-version.ts';

describe('openChamber host version', () => {
  test('parses core semver', () => {
    expect(parseOpenChamberVersion('1.22.0')).toEqual({ major: 1, minor: 22, patch: 0 });
    expect(parseOpenChamberVersion('v1.22.0-beta.1')).toEqual({ major: 1, minor: 22, patch: 0 });
    expect(parseOpenChamberVersion('junk')).toBeNull();
  });

  test('compares versions', () => {
    expect(compareOpenChamberVersions('1.22.0', '1.21.9')).toBeGreaterThan(0);
    expect(compareOpenChamberVersions('1.22.0', '1.22.0')).toBe(0);
    expect(compareOpenChamberVersions('1.21.0', '1.22.0')).toBeLessThan(0);
  });

  test('normalizes engines.openchamber floors', () => {
    expect(openChamberEngineMinimum('1.22.0')).toBe('1.22.0');
    expect(openChamberEngineMinimum('>=1.22.0')).toBe('1.22.0');
    expect(openChamberEngineMinimum('^1.22.0')).toBeNull();
  });

  test('checks host against engines.openchamber', () => {
    expect(hostMeetsOpenChamberEngine('1.22.0', '>=1.22.0')).toBe(true);
    expect(hostMeetsOpenChamberEngine('1.22.0', '1.22.0')).toBe(true);
    expect(hostMeetsOpenChamberEngine('1.21.9', '>=1.22.0')).toBe(false);
    expect(hostMeetsOpenChamberEngine('unknown', '>=1.22.0')).toBe(false);
  });
});
