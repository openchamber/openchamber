import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { TimelineProjectIcon } from '@/components/session/sidebar/sessions/SessionTimelineRowBody';
import type { ConversationResultContext } from './conversationResultContext';
import type { SearchMetaItem } from './SearchMetaList';

type ConversationContextKindLabels = {
  project: string;
  folder: string;
  branch: string;
  space: string;
};

export function conversationContextItems(context: ConversationResultContext, kindLabels: ConversationContextKindLabels): SearchMetaItem[] {
  const items: SearchMetaItem[] = [];
  if (context.project) {
    items.push({
      key: 'project',
      text: context.project.label,
      dir: 'auto',
      icon: React.createElement(TimelineProjectIcon, { project: context.project, label: null }),
      iconLabel: kindLabels.project,
    });
  } else if (context.folderLabel) {
    items.push({
      key: 'folder',
      text: context.folderLabel,
      dir: 'auto',
      icon: React.createElement(Icon, { name: 'folder', className: 'h-3 w-3' }),
      iconLabel: kindLabels.folder,
      title: context.folderPath ?? undefined,
    });
  }
  if (context.spaceLabel) {
    items.push({
      key: 'space',
      text: context.spaceLabel,
      dir: 'auto',
      icon: React.createElement(Icon, { name: 'instance', className: 'h-3 w-3' }),
      iconLabel: kindLabels.space,
    });
  } else if (context.branchLabel) {
    items.push({
      key: 'branch',
      text: context.branchLabel,
      dir: 'ltr',
      icon: React.createElement(Icon, { name: 'git-branch', className: 'h-3 w-3' }),
      iconLabel: kindLabels.branch,
    });
  } else if (context.worktreeFolder) {
    items.push({
      key: 'worktree-folder',
      text: context.worktreeFolder,
      dir: 'ltr',
      icon: React.createElement(Icon, { name: 'folder', className: 'h-3 w-3' }),
      iconLabel: kindLabels.folder,
      title: context.worktreePath ?? undefined,
    });
  }
  return context.extras ? [...items, ...context.extras] : items;
}
