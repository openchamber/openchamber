import type React from 'react';

import { Icon } from '@/components/icon/Icon';
import { isVSCodeRuntime } from '@/lib/desktop';
import type { useI18n } from '@/lib/i18n';
import type { ShortcutActionId } from '@/lib/shortcuts';
import { openNewWorktreeDialog } from '@/lib/paletteCommands';
import { createWorktreeSession } from '@/lib/worktreeSessionCreator';
import { openOrToggleLeadDraft } from '@/sync/session-lead';

export type CommandEntry = {
  id: string;
  title: string;
  icon: React.ReactNode;
  shortcutId?: ShortcutActionId;
  searchText: string;
  detail?: string;
  keywords?: string;
  secondary?: boolean;
  onSelect: () => void;
};

type Run = (fn: () => void | boolean | Promise<void>) => () => void;

export const createCommands = ({ t, run, startSession }: { t: ReturnType<typeof useI18n>['t']; run: Run; startSession: () => void }): CommandEntry[] => [
  {
    id: 'new-session',
    title: t('commandPalette.item.newSession'),
    icon: <Icon name="add" className="me-2 h-4 w-4" />,
    shortcutId: 'new_chat',
    searchText: t('commandPalette.item.newSession'),
    onSelect: run(startSession),
  },
  {
    id: 'new-worktree',
    title: t('commandPalette.item.quickWorktree'),
    icon: <Icon name="flashlight" className="me-2 h-4 w-4" />,
    shortcutId: 'new_chat_worktree',
    searchText: t('commandPalette.item.quickWorktree'),
    onSelect: run(() => {
      void createWorktreeSession();
    }),
  },
  {
    id: 'new-worktree-dialog',
    title: t('commandPalette.item.newWorktreeDialog'),
    icon: <Icon name="worktree" className="me-2 h-4 w-4" />,
    shortcutId: 'open_new_worktree_dialog',
    searchText: t('commandPalette.item.newWorktreeDialog'),
    onSelect: run(openNewWorktreeDialog),
  },
  ...(isVSCodeRuntime() ? [] : [{
    id: 'new-lead',
    title: t('commandPalette.item.newLead'),
    icon: <Icon name="lead" className="me-2 h-4 w-4" />,
    shortcutId: 'new_lead' as const,
    searchText: t('commandPalette.item.newLead'),
    onSelect: run(() => openOrToggleLeadDraft()),
  }]),
];
