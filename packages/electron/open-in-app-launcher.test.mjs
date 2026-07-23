import { describe, expect, test } from 'bun:test';

import { buildLinuxDesktopExecSpec, parseLinuxDesktopExecProgram } from './open-in-app-launcher.mjs';

describe('Linux desktop Exec launcher helpers', () => {
  test('preserves Flatpak wrapper arguments and replaces file placeholders', () => {
    const spec = buildLinuxDesktopExecSpec('flatpak run com.visualstudio.code %F', '/tmp/project');

    expect(spec).toEqual({
      program: 'flatpak',
      args: ['run', 'com.visualstudio.code', '/tmp/project'],
    });
  });

  test('keeps quoted arguments as single argv entries', () => {
    const spec = buildLinuxDesktopExecSpec('code --profile "Work Profile" %f', '/tmp/file.txt');

    expect(spec).toEqual({
      program: 'code',
      args: ['--profile', 'Work Profile', '/tmp/file.txt'],
    });
  });

  test('drops metadata field codes and appends the target when no target placeholder exists', () => {
    const spec = buildLinuxDesktopExecSpec('app --name %c %%literal', '/tmp/project');

    expect(spec).toEqual({
      program: 'app',
      args: ['--name', '%literal', '/tmp/project'],
    });
  });

  test('skips env assignments when deriving the executable program', () => {
    expect(parseLinuxDesktopExecProgram('env GTK_USE_PORTAL=1 flatpak run dev.openchamber.App %U')).toBe('flatpak');
  });
});
