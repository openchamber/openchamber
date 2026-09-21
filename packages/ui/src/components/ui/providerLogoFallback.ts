import type { IconName } from '@/components/icon/icons';

const COMMAND_CODE_PROVIDER_IDS = new Set(['command-code', 'commandcode', 'command_code', 'command code']);

export function getProviderLogoFallbackIcon(providerId: string | null | undefined): IconName | null {
  return providerId && COMMAND_CODE_PROVIDER_IDS.has(providerId.trim().toLowerCase())
    ? 'terminal-box'
    : null;
}
