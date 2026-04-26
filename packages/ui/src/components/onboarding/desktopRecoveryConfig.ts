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
  titleKey: string;
  descriptionKey: string;
  descriptionParams?: Record<string, string>;
  iconKey: 'local' | 'remote';
  showRetry: boolean;
  retryLabel?: string;
  retryLabelKey?: string;
  showUseLocal: boolean;
  showUseRemote: boolean;
  /** Label for the "use local" primary action button */
  useLocalLabel: string;
  useLocalLabelKey: string;
  /** Label for the "use remote" primary action button */
  useRemoteLabel: string;
  useRemoteLabelKey: string;
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
        description: 'OpenCode CLI could not be started or is not installed. Install OpenCode or connect to a remote server instead.',
        titleKey: 'onboarding.desktopRecovery.localUnavailable.title',
        descriptionKey: 'onboarding.desktopRecovery.localUnavailable.description',
        iconKey: 'local',
        showRetry: true,
        retryLabel: 'Retry Local',
        retryLabelKey: 'onboarding.desktopRecovery.localUnavailable.retry',
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: 'Set Up Local',
        useLocalLabelKey: 'onboarding.desktopRecovery.localUnavailable.useLocal',
        useRemoteLabel: 'Use Remote',
        useRemoteLabelKey: 'onboarding.desktopRecovery.common.useRemote',
      };

    case 'remote-missing':
      return {
        title: 'No Default Connection',
        description: 'Your saved default connection could not be found. Choose how you want to connect.',
        titleKey: 'onboarding.desktopRecovery.noDefaultConnection.title',
        descriptionKey: 'onboarding.desktopRecovery.noDefaultConnection.description',
        iconKey: 'local',
        showRetry: false,
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: 'Use Local',
        useLocalLabelKey: 'onboarding.desktopRecovery.common.useLocal',
        useRemoteLabel: 'Use Remote',
        useRemoteLabelKey: 'onboarding.desktopRecovery.common.useRemote',
      };

    case 'remote-unreachable': {
      const host = formatHostDisplay(hostLabel, hostUrl);
      return {
        title: 'Remote Server Unreachable',
        description: `Could not connect to "${host || 'the remote server'}". Check your network connection and verify the server address.`,
        titleKey: 'onboarding.desktopRecovery.remoteUnreachable.title',
        descriptionKey: 'onboarding.desktopRecovery.remoteUnreachable.description',
        descriptionParams: host ? { host } : undefined,
        iconKey: 'remote',
        showRetry: true,
        retryLabel: 'Retry Connection',
        retryLabelKey: 'onboarding.desktopRecovery.remoteUnreachable.retry',
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: 'Use Local',
        useLocalLabelKey: 'onboarding.desktopRecovery.common.useLocal',
        useRemoteLabel: 'Use Remote',
        useRemoteLabelKey: 'onboarding.desktopRecovery.common.useRemote',
      };
    }

    case 'remote-wrong-service': {
      const host = formatHostDisplay(hostLabel, hostUrl);
      return {
        title: 'Incompatible Server',
        description: `The server at "${host || 'unknown'}" is not running OpenChamber. Verify the address points to an OpenChamber server.`,
        titleKey: 'onboarding.desktopRecovery.incompatibleServer.title',
        descriptionKey: 'onboarding.desktopRecovery.incompatibleServer.description',
        descriptionParams: host ? { host } : undefined,
        iconKey: 'remote',
        showRetry: false,
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: 'Use Local',
        useLocalLabelKey: 'onboarding.desktopRecovery.common.useLocal',
        useRemoteLabel: 'Use Remote',
        useRemoteLabelKey: 'onboarding.desktopRecovery.common.useRemote',
      };
    }

    case 'missing-default-host':
      return {
        title: 'No Default Connection',
        description: 'Your saved default connection could not be found. Choose how you want to connect.',
        titleKey: 'onboarding.desktopRecovery.noDefaultConnection.title',
        descriptionKey: 'onboarding.desktopRecovery.noDefaultConnection.description',
        iconKey: 'local',
        showRetry: false,
        showUseLocal: true,
        showUseRemote: true,
        useLocalLabel: 'Use Local',
        useLocalLabelKey: 'onboarding.desktopRecovery.common.useLocal',
        useRemoteLabel: 'Use Remote',
        useRemoteLabelKey: 'onboarding.desktopRecovery.common.useRemote',
      };

    default: {
      // TypeScript exhaustive check - this should never be reached
      const exhaustive: never = variant;
      throw new Error(`Unknown recovery variant: ${exhaustive}`);
    }
  }
}
