import { describe, expect, it } from 'bun:test';
import path from 'path';
import { pathToFileURL } from 'url';

import { isModuleCliExecution, normalizeCliEntryPath } from './cli-entry.js';

describe('cli entry detection', () => {
  const modulePath = '/tmp/openchamber/bin/cli.js';
  const moduleUrl = pathToFileURL(modulePath).href;

  it('resolves symlinked entry paths before comparing', () => {
    const symlinkPath = '/usr/local/bin/openchamber';
    const realpath = (filePath) => {
      if (filePath === path.resolve(symlinkPath)) {
        return modulePath;
      }
      return filePath;
    };

    expect(isModuleCliExecution(symlinkPath, moduleUrl, realpath)).toBe(true);
  });

  it('falls back to resolved paths when realpath fails', () => {
    const realpath = () => {
      throw new Error('realpath unavailable');
    };

    expect(isModuleCliExecution(modulePath, moduleUrl, realpath)).toBe(true);
  });

  it('returns false for non-matching entry path', () => {
    expect(isModuleCliExecution('/tmp/other-cli.js', moduleUrl)).toBe(false);
  });

  it('returns false for empty entry path', () => {
    expect(isModuleCliExecution('', moduleUrl)).toBe(false);
  });

  it('returns false when module url is not provided', () => {
    expect(isModuleCliExecution(modulePath)).toBe(false);
  });

  it('accepts wrapper binary name fallback when requested', () => {
    const wrapperPath = '/home/user/.local/bin/openchamber';
    expect(isModuleCliExecution(wrapperPath, moduleUrl, undefined, 'openchamber')).toBe(true);
  });

  it('normalizes direct paths when realpath fails', () => {
    const unresolvedPath = './packages/web/bin/cli.js';
    const realpath = () => {
      throw new Error('no symlink resolution');
    };

    expect(normalizeCliEntryPath(unresolvedPath, realpath)).toBe(path.resolve(unresolvedPath));
  });
});
