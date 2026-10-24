import { describe, expect, it } from 'vitest';
import { resolveResponsibleLaunch } from './macos-responsibility.js';

const helper = '/App/Resources/disclaim/disclaim';
const present = (candidate) => candidate === helper;

describe('resolveResponsibleLaunch', () => {
  it('starts the command through the bundled helper on macOS', () => {
    expect(resolveResponsibleLaunch('/bin/zsh', ['-l'], { platform: 'darwin', resourcesPath: '/App/Resources', isExecutable: present }))
      .toEqual({ executable: helper, args: ['/bin/zsh', '-l'] });
  });

  it('leaves the launch alone without the helper', () => {
    expect(resolveResponsibleLaunch('/bin/zsh', ['-l'], { platform: 'darwin', resourcesPath: '/App/Resources', isExecutable: () => false }))
      .toEqual({ executable: '/bin/zsh', args: ['-l'] });
    expect(resolveResponsibleLaunch('/bin/zsh', ['-l'], { platform: 'darwin', resourcesPath: undefined, isExecutable: present }))
      .toEqual({ executable: '/bin/zsh', args: ['-l'] });
  });

  it('leaves the launch alone on other platforms', () => {
    expect(resolveResponsibleLaunch('/bin/bash', [], { platform: 'linux', resourcesPath: '/App/Resources', isExecutable: present }))
      .toEqual({ executable: '/bin/bash', args: [] });
  });
});
