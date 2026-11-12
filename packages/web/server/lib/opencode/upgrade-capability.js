export const resolveOpenCodeUpgradeCapability = ({
  isExternal,
  hasManagedProcess,
  activeBinary,
  isBundledBinary,
  pinnedByPolicy = false,
}) => {
  if (isExternal) {
    return {
      supported: false,
      manager: 'external',
      reason: 'external',
    };
  }

  // The administrator pinned the CLI in the policy file and owns its updates.
  if (pinnedByPolicy) {
    return {
      supported: false,
      manager: 'administrator',
      reason: 'policy',
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
