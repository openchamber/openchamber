import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { SessionSidebarActivityKey } from './sessionSidebarRowModel';
import { ACTIVITY_TITLE_KEY, isBuiltinActivityKey } from './sessionSidebarActivityLabels';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { sessionEvents } from '@/lib/sessionEvents';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Add project at the end of the caption over the projects. Always shown: it is
 * the way to the sidebar's first step, which a hover would hide.
 */
const AddProjectButton: React.FC = () => {
  const { t } = useI18n();
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const label = t('sessions.sidebar.header.actions.addProject');
  return <Tooltip>
    <TooltipTrigger asChild>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); sessionEvents.requestDirectoryDialog(); }}
        className="absolute inset-e-0.5 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
        aria-label={label}
      >
        <Icon name="add" className="h-4 w-4" />
      </button>
    </TooltipTrigger>
    <TooltipContent side="top">
      <TooltipLabelWithShortcut label={label} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('add_project', shortcutOverrides), '')} />
    </TooltipContent>
  </Tooltip>;
};

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
  /** The zone's list is still loading and has nothing to show yet. */
  loading?: boolean;
  collapsed: boolean;
  alwaysShowActions: boolean;
  onToggle: () => void;
  onNewChat: () => void;
}> = ({ activityKey, label, preview = false, loading = false, collapsed, alwaysShowActions, onToggle, onNewChat }) => {
  const { t } = useI18n();
  const chats = activityKey === 'chats';
  // The list by time is the Projects section, so it adds projects as its caption does.
  const timeline = activityKey === 'timeline';
  // One header for every zone, so zones line up with the project headers.
  return <div className="relative group/chats -ms-2.5 -me-2">
    <button
      type="button"
      onClick={onToggle}
      // The caption's own toggle: pressing it can lift the section (`rowDrag`).
      data-row-drag=""
      className={cn('group flex w-full items-center gap-1 py-1 ps-4 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', chats || timeline ? 'pe-10' : 'pe-3.5')}
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
      <Icon
        name={collapsed ? 'arrow-right-s' : 'arrow-down-s'}
        className={cn(
          'h-3.5 w-3.5 text-muted-foreground',
          collapsed || alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
        )}
      />
      {/* Inside the caption's own line, so the rows below never move. */}
      {loading ? <Spinner className="size-3 text-muted-foreground" aria-label={t('sessions.sidebar.group.empty.loadingSessions')} /> : null}
    </button>
    {chats ? <button
      type="button"
      onClick={(event) => { event.stopPropagation(); onNewChat(); }}
      className={cn('absolute inset-e-0.5 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/chats:opacity-100 group-hover/chats:pointer-events-auto group-has-[:focus-visible]/chats:opacity-100 group-has-[:focus-visible]/chats:pointer-events-auto')}
      aria-label={t('sessions.sidebar.header.actions.newSession')}
    >
      <Icon name="add" className="h-4 w-4" />
    </button> : null}
    {timeline ? <AddProjectButton /> : null}
  </div>;
};

/** The caption over the projects: a zone's label that folds every project away. */
export const SessionSidebarCaption: React.FC<{
  /** The name of a group of projects the user made; Projects otherwise. */
  label?: string;
  preview?: boolean;
  collapsed: boolean;
  alwaysShowActions: boolean;
  /** The caption of Projects, which ends in Add project; a group of projects has none. */
  addsProjects: boolean;
  onToggle: () => void;
}> = ({ label, preview = false, collapsed, alwaysShowActions, addsProjects, onToggle }) => {
  const { t } = useI18n();
  return <div className="relative -ms-2.5 -me-2">
    <button
      type="button"
      onClick={onToggle}
      // The caption's own toggle: pressing it can lift the section (`rowDrag`).
      data-row-drag=""
      className={cn('group flex w-full items-center gap-1 py-1 ps-4 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', addsProjects ? 'pe-10' : 'pe-3.5')}
      aria-expanded={!collapsed}
    >
      <span className="min-w-0 truncate typography-ui-label font-medium text-muted-foreground" dir="auto">
        {label ?? t('sessions.sidebar.activity.projectsTitle')}
      </span>
      {preview ? <PreviewMark /> : null}
      <Icon
        name={collapsed ? 'arrow-right-s' : 'arrow-down-s'}
        className={cn(
          'h-3.5 w-3.5 text-muted-foreground',
          collapsed || alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
        )}
      />
    </button>
    {addsProjects ? <AddProjectButton /> : null}
  </div>;
};
