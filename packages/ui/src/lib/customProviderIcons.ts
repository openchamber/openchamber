import type { IconName } from '@/components/icon/icons';

export const CUSTOM_PROVIDER_ICONS = [
  { id: 'server', icon: 'server' },
  { id: 'cloud', icon: 'cloud' },
  { id: 'database', icon: 'database-2' },
  { id: 'terminal', icon: 'terminal-box' },
  { id: 'code', icon: 'code-box' },
  { id: 'ai', icon: 'brain-ai-3' },
] as const satisfies ReadonlyArray<{ id: string; icon: IconName }>;

export type CustomProviderIcon = (typeof CUSTOM_PROVIDER_ICONS)[number]['id'];

const CUSTOM_PROVIDER_ICON_IDS = new Set<string>(CUSTOM_PROVIDER_ICONS.map((entry) => entry.id));

export const isCustomProviderIcon = (value: unknown): value is CustomProviderIcon => (
  typeof value === 'string' && CUSTOM_PROVIDER_ICON_IDS.has(value)
);

export const customProviderIconName = (value: CustomProviderIcon): IconName => (
  CUSTOM_PROVIDER_ICONS.find((entry) => entry.id === value)?.icon ?? 'server'
);