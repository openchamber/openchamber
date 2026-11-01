import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { SessionSidebarActivityKey } from './sessionSidebarRowModel';
import { ACTIVITY_TITLE_KEY, isBuiltinActivityKey } from './sessionSidebarActivityLabels';

/** The mark on the section being edited, which the sidebar draws as it stands. */
const PreviewMark: React.FC = () => {
  const { t } = useI18n();
  return <span className="ms-1 rounded-full bg-interactive-selection px-1.5 typography-micro text-interactive-selection-foreground">
    {t('sessions.sidebar.sections.previewMark')}
  </span>;
};


export const SessionSidebarActivityHeader: React.FC<{
  activityKey: SessionSidebarActivityKey;
  /** The name of one of the user's sections. */
  label?: string;
  preview?: boolean;
  collapsed: boolean;
  forceExpanded: boolean;
  alwaysShowActions: boolean;
  onToggle: () => void;
  onNewChat: () => void;
}> = ({ activityKey, label, preview = false, collapsed, forceExpanded, alwaysShowActions, onToggle, onNewChat }) => {
  const { t } = useI18n();
  const chats = activityKey === 'chats';
  // One header for every zone, so zones line up with the project headers.
  return <div className="relative group/chats -ms-2.5 -me-2">
    <button
      type="button"
      onClick={forceExpanded ? undefined : onToggle}
      disabled={forceExpanded}
      // The caption's own toggle: pressing it can lift the section (`rowDrag`).
      data-row-drag=""
      className={cn('group flex w-full items-center gap-1 py-1 ps-4 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', chats ? 'pe-10' : 'pe-3.5')}
      aria-expanded={!collapsed}
    >
      {/* A zone's label is a bare muted word with room above it, so it reads
          as the caption of what follows; the icons belong to projects and
          rows. The chevron follows the word: always while the zone is closed,
          on hover while it is open. */}
      <span className="min-w-0 truncate typography-ui-label font-medium text-muted-foreground" dir="auto">
        {label ?? (isBuiltinActivityKey(activityKey) ? t(ACTIVITY_TITLE_KEY[activityKey]) : '')}
      </span>
      {preview ? <PreviewMark /> : null}
      {!forceExpanded ? (
        <Icon
          name={collapsed ? 'arrow-right-s' : 'arrow-down-s'}
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground',
            collapsed || alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
          )}
        />
      ) : null}
    </button>
    {chats ? <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onNewChat(); }}
      className={cn('absolute inset-e-0.5 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/chats:opacity-100 group-hover/chats:pointer-events-auto group-has-[:focus-visible]/chats:opacity-100 group-has-[:focus-visible]/chats:pointer-events-auto')}
      aria-label={t('sessions.sidebar.header.actions.newSession')}
    >
      <Icon name="add" className="h-4 w-4" />
    </button> : null}
  </div>;
};

/** The caption over the projects: a zone's label that folds every project away. */
export const SessionSidebarCaption: React.FC<{
  /** The name of a group of projects the user made; Projects otherwise. */
  label?: string;
  preview?: boolean;
  collapsed: boolean;
  forceExpanded: boolean;
  alwaysShowActions: boolean;
  onToggle: () => void;
}> = ({ label, preview = false, collapsed, forceExpanded, alwaysShowActions, onToggle }) => {
  const { t } = useI18n();
  return <div className="relative -ms-2.5 -me-2">
    <button
      type="button"
      onClick={forceExpanded ? undefined : onToggle}
      disabled={forceExpanded}
      // The caption's own toggle: pressing it can lift the section (`rowDrag`).
      data-row-drag=""
      className="group flex w-full items-center gap-1 py-1 ps-4 pe-3.5 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      aria-expanded={!collapsed}
    >
      <span className="min-w-0 truncate typography-ui-label font-medium text-muted-foreground" dir="auto">
        {label ?? t('sessions.sidebar.activity.projectsTitle')}
      </span>
      {preview ? <PreviewMark /> : null}
      {!forceExpanded ? (
        <Icon
          name={collapsed ? 'arrow-right-s' : 'arrow-down-s'}
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground',
            collapsed || alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
          )}
        />
      ) : null}
    </button>
  </div>;
};
