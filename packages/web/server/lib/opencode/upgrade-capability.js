// TEMPORARY WORKAROUND — Windows ARM64: native opencode.exe fails with a Bun
// FFI/TinyCC dlopen error (https://github.com/anomalyco/opencode/issues/19130).
// Disable OpenCode self-upgrade on ARM64 so it can't overwrite the working x64
// binary with the broken ARM64 build. Remove when the upstream issue is resolved.
const isWindowsArm64 = () => process.platform === 'win32' && process.arch === 'arm64';

export const resolveOpenCodeUpgradeCapability = ({
  isExternal,
  hasManagedProcess,
  activeBinary,
  isBundledBinary,
}) => {
  if (isWindowsArm64()) {
    return {
      supported: false,
      manager: 'openchamber',
      reason: 'windows-arm64-workaround',
    };
  }

  if (isExternal) {
    return {
      supported: false,
      manager: 'external',
      reason: 'external',
    };
  }

  if (!hasManagedProcess || !activeBinary) {
    return {
      supported: false,
      manager: null,
      reason: 'unavailable',
    };
  }

  if (isBundledBinary(activeBinary)) {
    return {
      supported: false,
      manager: 'openchamber',
      reason: 'bundled',
    };
  }

  return {
    supported: true,
    manager: 'opencode',
    reason: null,
  };
};
