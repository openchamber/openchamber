import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useI18n } from '@/lib/i18n';
import { useObserveProjectActionRuns, useProjectActions } from './projectActionsRunnerContext';
import { AUTO_DISCOVER_ACTION_ID, resolveProjectActionIconName } from '@/lib/projectActions';
import { ProjectActionRunIndicator } from './ProjectActionRunIndicator';

/**
 * The Work Status row: runs or stops the action it shows, and its chevron
 * picks another. The runner itself lives in `ProjectActionsProvider`.
 */
const ProjectActionsButtonComponent = () => {
  const { t } = useI18n();
  const runner = useProjectActions();
  const openContextPreview = useUIStore((state) => state.openContextPreview);
  useObserveProjectActionRuns(true);

  const shown = runner?.shown ?? null;
  const shownRun = shown && runner ? runner.runOf(shown) : null;
  const shownRunPreviewUrl = useTerminalStore((state) => {
    if (!shownRun) return null;
    return state.getDirectoryState(shownRun.directory)?.tabs.find((tab) => tab.id === shownRun.tabId)?.previewUrl ?? null;
  });

  if (!runner || !shown) {
    return null;
  }

  const isStoppingShown = shownRun?.status === 'stopping';
  const handleOpenShownPreview = () => {
    if (!shownRun || !shownRunPreviewUrl) {
      return;
    }
    openContextPreview(shownRun.directory, shownRunPreviewUrl);
  };

  return (
    <div className="group/action relative flex h-7 w-full items-center gap-2 rounded-md px-1 text-muted-foreground transition-colors hover:text-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => runner.toggle(shown)}
            disabled={runner.isLoading || isStoppingShown}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-start focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)] disabled:cursor-not-allowed"
            aria-label={shownRun
              ? t('projectActions.actions.stopNamedAria', { name: shown.name })
              : t('projectActions.actions.runNamedAria', { name: shown.name })}
          >
            <Icon name={resolveProjectActionIconName(shown)} className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-[13px]">{shown.name}</span>
            {/* The state is the trailing value: what pressing the row does next. */}
            <ProjectActionRunIndicator run={shownRun} showIdle />
          </button>
        </TooltipTrigger>
        {shown.id === AUTO_DISCOVER_ACTION_ID ? (
          <TooltipContent side="left" sideOffset={8}>{t('projectActions.actions.autoDiscoverTooltip')}</TooltipContent>
        ) : null}
      </Tooltip>
      {shownRun && shownRunPreviewUrl ? (
        <button
          type="button"
          onClick={handleOpenShownPreview}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]"
          aria-label={t('projectActions.actions.openPreview')}
          title={t('projectActions.actions.openPreview')}
        >
          <Icon name="global" className="size-4" />
        </button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--interactive-focus-ring)]"
            aria-label={t('projectActions.actions.chooseActionAria')}
          >
            <Icon name="arrow-down-s" className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent data-work-status-popup align="end" className="w-60 max-h-[70vh] overflow-y-auto">
          <DropdownMenuItem className="flex items-center gap-2" onClick={runner.openSettings}>
            <Icon name="add" className="h-4 w-4" />
            <span className="typography-ui-label text-foreground">{t('projectActions.actions.addNewAction')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {runner.actions.map((entry) => (
            <DropdownMenuItem
              key={entry.id}
              className="flex items-center gap-2"
              onClick={() => {
                runner.select(entry);
                runner.toggle(entry);
              }}
            >
              <Icon name={resolveProjectActionIconName(entry)} className="h-4 w-4" />
              <span className="typography-ui-label text-foreground truncate">{entry.name}</span>
              {entry.source === 'shared' ? (
                <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-muted-foreground bg-[var(--surface-subtle)]">
                  {t('projectActions.menu.sharedBadge')}
                </span>
              ) : null}
              <ProjectActionRunIndicator run={runner.runOf(entry)} className="ms-auto" />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

// Memoised: it sits in the work-status card, which re-renders on every streamed
// message; it re-renders on its own when the runner changes.
export const ProjectActionsButton = React.memo(ProjectActionsButtonComponent);
