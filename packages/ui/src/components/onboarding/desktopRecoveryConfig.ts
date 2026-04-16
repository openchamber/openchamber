import { redactSensitiveUrl } from '@/lib/desktopHosts';
import { m } from '@/lib/i18n/messages';

export type RecoveryVariant =
  | 'local-unavailable'
  | 'remote-unreachable'
  | 'remote-wrong-service'
  | 'remote-missing'
  | 'missing-default-host';

export type DesktopRecoveryConfig = {
  title: string;
  description: string;
  iconKey: 'local' | 'remote';
  showRetry: boolean;
  retryLabel?: string;
  showUseLocal: boolean;
  showUseRemote: boolean;
  /** Label for the "use local" primary action button */
  useLocalLabel: string;
  /** Label for the "use remote" primary action button */
  useRemoteLabel: string;
};

function formatHostDisplay(hostLabel?: string, hostUrl?: string): string | undefined {
  if (hostLabel?.trim()) return redactSensitiveUrl(hostLabel.trim());
  if (hostUrl) return redactSensitiveUrl(hostUrl);
  return undefined;
}

export function getDesktopRecoveryConfig(
  variant: RecoveryVariant,
  hostLabel?: string,
  hostUrl?: string,
): DesktopRecoveryConfig {
  switch (variant) {
    case 'local-unavailable':
      return {
        title: m.obLocalUnavailableTitle(),
        description: m.obLocalUnavailableDescription(),
        iconKey: 'local',
        showRetry: true,
        retryLabel: m.obRetryLocal(),
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: m.obSetUpLocal(),
        useRemoteLabel: m.obUseRemote(),
      };

    case 'remote-missing':
      return {
        title: m.obNoDefaultConnection(),
        description: m.obNoDefaultConnectionDescription(),
        iconKey: 'local',
        showRetry: false,
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: m.obSetUpLocal(),
        useRemoteLabel: m.obUseRemote(),
      };

    case 'remote-unreachable': {
      const host = formatHostDisplay(hostLabel, hostUrl);
      return {
        title: m.obRemoteServerUnreachableTitle(),
        description: m.obRemoteServerUnreachableDescription({ host }),
        iconKey: 'remote',
        showRetry: true,
        retryLabel: m.obRetryConnection(),
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: m.obSetUpLocal(),
        useRemoteLabel: m.obUseRemote(),
      };
    }

    case 'remote-wrong-service': {
      const host = formatHostDisplay(hostLabel, hostUrl);
      return {
        title: m.obIncompatibleServer(),
        description: m.obIncompatibleServerDescription({ host }),
        iconKey: 'remote',
        showRetry: false,
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: m.obSetUpLocal(),
        useRemoteLabel: m.obUseRemote(),
      };
    }

    case 'missing-default-host':
      return {
        title: m.obNoDefaultConnection(),
        description: m.obNoDefaultConnectionDescription(),
        iconKey: 'local',
        showRetry: false,
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: m.obSetUpLocal(),
        useRemoteLabel: m.obUseRemote(),
      };

    default: {
      // TypeScript exhaustive check - this should never be reached
      const exhaustive: never = variant;
      throw new Error(`Unknown recovery variant: ${exhaustive}`);
    }
  }
}
