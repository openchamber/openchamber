import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { SessionSidebarActivityKey } from './sessionSidebarRowModel';

const ACTIVITY_ICON = { chats: 'chat-4', 'active-now': 'history', timeline: 'folder' } as const;
const ACTIVITY_TITLE_KEY = {
  chats: 'sessions.sidebar.activity.chatsTitle',
  'active-now': 'sessions.sidebar.activity.recentTitle',
  timeline: 'sessions.sidebar.activity.timelineTitle',
} as const;

export const SessionSidebarActivityHeader: React.FC<{
  activityKey: SessionSidebarActivityKey;
  collapsed: boolean;
  forceExpanded: boolean;
  alwaysShowActions: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  /** Timeline zones drop the leading icon and take a taller band; the
      collapse chevron still appears on hover in the icon slot. */
  timelineView?: boolean;
}> = ({ activityKey, collapsed, forceExpanded, alwaysShowActions, onToggle, onNewChat, timelineView = false }) => {
  const { t } = useI18n();
  const chats = activityKey === 'chats';
  if (timelineView) {
    // Timeline zone header: no icon, text flush with the rows' left edge, and
    // an always-visible chevron right after the title showing collapse state.
    return <div className="relative group/chats -mr-2">
      <button
        type="button"
        onClick={forceExpanded ? undefined : onToggle}
        disabled={forceExpanded}
        className={cn('group flex w-full items-center gap-1 py-2 pl-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', 'pr-3.5')}
        aria-expanded={!collapsed}
      >
        <span className="typography-ui-label font-semibold lowercase text-foreground">
          {t(ACTIVITY_TITLE_KEY[activityKey])}
        </span>
        {!forceExpanded ? <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5 text-muted-foreground" /> : null}
      </button>
    </div>;
  }
  return <div className="relative group/chats -ml-2.5 -mr-2">
    <button
      type="button"
      onClick={forceExpanded ? undefined : onToggle}
      disabled={forceExpanded}
      className={cn('group flex w-full items-center gap-1.5 py-1 pl-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', chats ? 'pr-10' : 'pr-3.5')}
      aria-expanded={!collapsed}
    >
      <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
        <Icon name={ACTIVITY_ICON[activityKey]} className={cn('h-3.5 w-3.5 text-muted-foreground/80', !forceExpanded && 'group-hover:hidden')} />
        {!forceExpanded ? <span className="hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground group-hover:inline-flex">
          <Icon name={collapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
        </span> : null}
      </span>
      <span className="typography-ui-label font-semibold lowercase text-foreground">
        {t(ACTIVITY_TITLE_KEY[activityKey])}
      </span>
    </button>
    {chats ? <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onNewChat(); }}
      className={cn('absolute right-0.5 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/chats:opacity-100 group-hover/chats:pointer-events-auto group-focus-within/chats:opacity-100 group-focus-within/chats:pointer-events-auto')}
      aria-label={t('sessions.sidebar.header.actions.newSession')}
    >
      <Icon name="add" className="h-4 w-4" />
    </button> : null}
  </div>;
};
