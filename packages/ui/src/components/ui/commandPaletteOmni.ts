import type { OmniCategory, OmniLifecycle } from '@/lib/search/omniQuery';

const PALETTE_CATEGORIES: readonly OmniCategory[] = ['all', 'sessions', 'messages', 'commands', 'files'];

export const nextPaletteCategory = (category: OmniCategory, direction: 1 | -1): OmniCategory => {
  const current = PALETTE_CATEGORIES.indexOf(category);
  return PALETTE_CATEGORIES[(current + direction + PALETTE_CATEGORIES.length) % PALETTE_CATEGORIES.length];
};

export const paletteLifecycle = (showArchived: boolean, lifecycle: OmniLifecycle | undefined): OmniLifecycle => (
  showArchived ? (lifecycle ?? 'all') : 'active'
);

export const shouldResetPaletteCategory = (category: OmniCategory, key: string, query: string): boolean => (
  category !== 'all' && (key === 'Escape' || (key === 'Backspace' && query.length === 0))
);
