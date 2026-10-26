import { describe, expect, it } from 'vitest';
import { helperShellCommand, helperSpawnEnv } from './helper-launch.js';

describe('helper launch', () => {
  it('names the executable and script for sh, quoting each part', () => {
    expect(helperShellCommand('/srv/helper.js', [], { execPath: "/opt/it's/bun", versions: {} }))
      .toBe("'/opt/it'\\''s/bun' '/srv/helper.js'");
    expect(helperShellCommand('/srv/helper.js', ['http://127.0.0.1:1/x', 'nonce'], { execPath: '/usr/bin/node', versions: {} }))
      .toBe("'/usr/bin/node' '/srv/helper.js' 'http://127.0.0.1:1/x' 'nonce'");
  });

  it('tells Electron to run as Node, inside the command and in the spawn env', () => {
    const versions = { electron: '39.0.0' };
    expect(helperShellCommand('/srv/helper.js', [], { execPath: '/Applications/OpenChamber.app/Contents/MacOS/OpenChamber', versions }))
      .toBe("ELECTRON_RUN_AS_NODE=1 '/Applications/OpenChamber.app/Contents/MacOS/OpenChamber' '/srv/helper.js'");
    expect(helperSpawnEnv({ PATH: '/bin' }, { versions })).toEqual({ PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' });
    expect(helperSpawnEnv({ PATH: '/bin' }, { versions: {} })).toEqual({ PATH: '/bin' });
  });
});
