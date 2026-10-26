import { describe, expect, test } from 'bun:test';

import { classifyUpdateInstallError, getUpdateInstallErrorMessage } from './updateInstallError';

describe('classifyUpdateInstallError', () => {
  test('recognizes a rejected code signature', () => {
    const error = new Error(
      'Code signature at URL file:///Users/me/Library/Caches/dev.openchamber.desktop.ShipIt/update.afN56TW/OpenChamber.app/ did not pass validation: code failed to satisfy specified code requirement(s)',
    );
    expect(classifyUpdateInstallError(error)).toBe('signature');
  });

  test('recognizes the disabled updater session left by an earlier failure', () => {
    expect(classifyUpdateInstallError(new Error('The command is disabled and cannot be executed'))).toBe(
      'updater-disabled',
    );
  });

  test('leaves an unknown installer failure unclassified', () => {
    expect(classifyUpdateInstallError(new Error('ENOSPC: no space left on device'))).toBe('unknown');
  });
});

describe('getUpdateInstallErrorMessage', () => {
  test('keeps the raw updater text for an unknown failure', () => {
    expect(getUpdateInstallErrorMessage(new Error('ENOSPC: no space left on device'))).toBe(
      'ENOSPC: no space left on device',
    );
  });

  test('never returns an empty message', () => {
    expect(getUpdateInstallErrorMessage(new Error('  ')).length).toBeGreaterThan(0);
    expect(getUpdateInstallErrorMessage(new Error('')).length).toBeGreaterThan(0);
  });
});
