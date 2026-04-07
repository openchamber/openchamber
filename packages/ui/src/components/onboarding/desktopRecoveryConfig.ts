import { redactSensitiveUrl } from '@/lib/desktopHosts';

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
        title: 'Local OpenCode Unavailable',
        description:
          'OpenCode CLI could not be started or is not installed. Install OpenCode or connect to a remote server instead.',
        iconKey: 'local',
        showRetry: true,
        retryLabel: 'Retry Local',
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: 'Set Up Local',
        useRemoteLabel: 'Use Remote',
      };

    case 'remote-missing':
      return {
        title: 'No Default Connection',
        description: 'Your saved default connection could not be found. Choose how you want to connect.',
        iconKey: 'local',
        showRetry: false,
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: 'Use Local',
        useRemoteLabel: 'Use Remote',
      };

    case 'remote-unreachable': {
      const host = formatHostDisplay(hostLabel, hostUrl);
      return {
        title: 'Remote Server Unreachable',
        description: `Could not connect to "${host || 'the remote server'}". Check your network connection and verify the server address.`,
        iconKey: 'remote',
        showRetry: true,
        retryLabel: 'Retry Connection',
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: 'Use Local',
        useRemoteLabel: 'Use Remote',
      };
    }

    case 'remote-wrong-service': {
      const host = formatHostDisplay(hostLabel, hostUrl);
      return {
        title: 'Incompatible Server',
        description: `The server at "${host || 'unknown'}" is not running OpenChamber. Verify the address points to an OpenChamber server.`,
        iconKey: 'remote',
        showRetry: false,
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: 'Use Local',
        useRemoteLabel: 'Use Remote',
      };
    }

    case 'missing-default-host':
      return {
        title: 'No Default Connection',
        description: 'Your saved default connection could not be found. Choose how you want to connect.',
        iconKey: 'local',
        showRetry: false,
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: 'Use Local',
        useRemoteLabel: 'Use Remote',
      };

    default: {
      // TypeScript exhaustive check - this should never be reached
      const exhaustive: never = variant;
      throw new Error(`Unknown recovery variant: ${exhaustive}`);
    }
  }
}
