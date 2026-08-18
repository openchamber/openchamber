import type { IconName } from '@/components/icon/icons';

export function getProviderLogoFallbackIcon(providerId: string | null | undefined): IconName | null {
  return providerId?.trim().toLowerCase() === 'command-code' ? 'terminal-box' : null;
}
