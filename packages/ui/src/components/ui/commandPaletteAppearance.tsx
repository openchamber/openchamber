import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { I18nKey } from '@/lib/i18n';
import { toggleReasoningTraces } from '@/lib/paletteCommands';
import { shortcutRegistry, type ShortcutActionId } from '@/lib/shortcuts';

type AppearanceCommand = {
  id: string;
  title: string;
  icon: React.ReactNode;
  shortcutId: ShortcutActionId;
  searchText: string;
  secondary: true;
  onSelect: () => void;
};

export const appearanceCommands = (
  t: (key: I18nKey) => string,
  run: (fn: () => void | boolean) => () => void,
): AppearanceCommand[] => [
  {
    id: 'cycle-theme',
    secondary: true,
    title: t('commandPalette.item.cycleTheme'),
    icon: <Icon name="palette" className="me-2 h-4 w-4" />,
    shortcutId: 'cycle_theme',
    searchText: t('commandPalette.item.cycleTheme'),
    onSelect: run(() => {
      shortcutRegistry.invoke('cycle_theme');
    }),
  },
  {
    id: 'toggle-reasoning-traces',
    secondary: true,
    title: t('commandPalette.item.toggleReasoningTraces'),
    icon: <Icon name="brain-ai-3" className="me-2 h-4 w-4" />,
    shortcutId: 'toggle_reasoning_traces',
    searchText: t('commandPalette.item.toggleReasoningTraces'),
    onSelect: run(toggleReasoningTraces),
  },
];
