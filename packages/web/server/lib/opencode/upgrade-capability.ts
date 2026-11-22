export interface OpenCodeUpgradeInput {
  isExternal: boolean;
  isSharedService?: boolean;
  hasManagedProcess: boolean;
  activeBinary: string | null | undefined;
  isBundledBinary: (binary: string) => boolean;
  pinnedByPolicy?: boolean;
}

export type OpenCodeUpgradeCapability =
  | { supported: false; manager: 'external'; reason: 'external' }
  | { supported: false; manager: 'administrator'; reason: 'policy' }
  | { supported: false; manager: null; reason: 'unavailable' }
  | { supported: false; manager: 'openchamber'; reason: 'bundled' }
  | { supported: true; manager: 'opencode'; reason: null };

export const resolveOpenCodeUpgradeCapability = ({
  isExternal,
  isSharedService = false,
  hasManagedProcess,
  activeBinary,
  isBundledBinary,
  pinnedByPolicy = false,
}: OpenCodeUpgradeInput): OpenCodeUpgradeCapability => {
  if (isSharedService && !pinnedByPolicy) {
    return { supported: true, manager: 'opencode', reason: null };
  }

  if (isExternal) {
    return {
      supported: false,
      manager: 'external',
      reason: 'external',
    };
  }

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
