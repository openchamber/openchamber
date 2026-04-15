import type { RecoveryVariant } from './desktopRecoveryConfig';

export type RecoveryPrimaryAction = 'use-local' | 'use-remote';

export type RecoveryNextStep =
  | { kind: 'local-setup' }
  | { kind: 'switch-default-to-local' }
  | { kind: 'remote-form' };

export function resolveRecoveryNextStep(
  variant: RecoveryVariant,
  action: RecoveryPrimaryAction,
): RecoveryNextStep {
  if (action === 'use-remote') {
    return { kind: 'remote-form' };
  }

  // action === 'use-local'
  switch (variant) {
    case 'local-unavailable':
      return { kind: 'local-setup' };
    case 'remote-unreachable':
    case 'remote-wrong-service':
    case 'remote-missing':
    case 'missing-default-host':
      return { kind: 'switch-default-to-local' };
    default: {
      const exhaustive: never = variant;
      throw new Error(`Unhandled RecoveryVariant: ${exhaustive}`);
    }
  }
}
