import type { Plugin } from 'vite';

export function themeStoragePlugin(): Plugin {
  return {
    name: 'theme-storage',
    // Plugin retained for compatibility but no longer handles custom themes
  };
}