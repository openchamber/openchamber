import { describe, expect, it, vi } from 'vitest';
import { resolveOpenCodeUpgradeCapability } from './upgrade-capability.js';

describe('OpenCode upgrade capability', () => {
  it('assigns bundled binaries to the OpenChamber updater', () => {
    const isBundledBinary = vi.fn(() => true);

    expect(resolveOpenCodeUpgradeCapability({
      isExternal: false,
      isSharedService: false,
      hasManagedProcess: true,
      activeBinary: '/Applications/OpenChamber.app/Contents/Resources/opencode-cli/opencode',
      isBundledBinary,
    })).toEqual({
      supported: false,
      manager: 'openchamber',
      reason: 'bundled',
    });
  });

  it('never upgrades external or unresolved runtimes', () => {
    const isBundledBinary = vi.fn(() => false);

    expect(resolveOpenCodeUpgradeCapability({
      isExternal: true,
      isSharedService: false,
      hasManagedProcess: false,
      activeBinary: null,
      isBundledBinary,
    })).toEqual({
      supported: false,
      manager: 'external',
      reason: 'external',
    });
    expect(resolveOpenCodeUpgradeCapability({
      isExternal: false,
      isSharedService: false,
      hasManagedProcess: false,
      activeBinary: '/usr/local/bin/opencode',
      isBundledBinary,
    })).toEqual({
      supported: false,
      manager: null,
      reason: 'unavailable',
    });
  });

  it('blocks upgrades owned by the shared OpenCode service', () => {
    expect(resolveOpenCodeUpgradeCapability({
      isExternal: false,
      isSharedService: true,
      hasManagedProcess: false,
      activeBinary: '/usr/local/bin/opencode2',
      isBundledBinary: () => false,
    })).toEqual({
      supported: false,
      manager: 'external',
      reason: 'shared-service',
    });
  });

  it('allows OpenCode to upgrade a managed non-bundled binary', () => {
    expect(resolveOpenCodeUpgradeCapability({
      isExternal: false,
      isSharedService: false,
      hasManagedProcess: true,
      activeBinary: '/Users/alice/.opencode/bin/opencode',
      isBundledBinary: () => false,
    })).toEqual({
      supported: true,
      manager: 'opencode',
      reason: null,
    });
  });
});
