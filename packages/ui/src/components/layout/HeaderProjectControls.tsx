import React from 'react';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { Icon } from '@/components/icon/Icon';
import { useUIStore } from '@/stores/useUIStore';
import { useTerminalStore } from '@/stores/useTerminalStore';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useObserveProjectActionRuns, useProjectActions } from './projectActionsRunnerContext';
import { ProjectActionRunIndicator } from './ProjectActionRunIndicator';
import { resolveProjectActionIconName } from '@/lib/projectActions';
import { OpenInAppButton } from '@/components/desktop/OpenInAppButton';
import { useProjectActionsContext } from '@/hooks/useProjectActionsContext';

const HeaderProjectActionComponent: React.FC<{ buttonClassName: string }> = ({ buttonClassName }) => {
  const { t } = useI18n();
  const runner = useProjectActions();
  const openContextPreview = useUIStore((state) => state.openContextPreview);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const allActionsShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('open_project_actions', shortcutOverrides), '');

  const shown = runner?.available ? runner.shown : null;
  const shownRun = shown && runner ? runner.runOf(shown) : null;
  useObserveProjectActionRuns(true);
  const previewUrl = useTerminalStore((state) => {
    if (!shownRun) return null;
    return state.getDirectoryState(shownRun.directory)?.tabs.find((tab) => tab.id === shownRun.tabId)?.previewUrl ?? null;
  });

  if (!runner || !shown) {
    return null;
  }

  const label = shownRun
    ? t('projectActions.actions.stopNamedAria', { name: shown.name })
    : t('projectActions.actions.runNamedAria', { name: shown.name });

  return (
    <>
      {shownRun && previewUrl ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => openContextPreview(shownRun.directory, previewUrl)}
              className={buttonClassName}
              aria-label={t('projectActions.actions.openPreview')}
            >
              <Icon name="global" className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('projectActions.actions.openPreview')}</TooltipContent>
        </Tooltip>
      ) : null}
      <ContextMenu onOpenChange={setMenuOpen}>
        <Tooltip>
          <ContextMenuTrigger render={<div className="inline-flex" />}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => runner.toggle(shown)}
                disabled={runner.isLoading || shownRun?.status === 'stopping'}
                className={cn(buttonClassName, menuOpen && 'text-foreground')}
                aria-label={label}
              >
                {shownRun
                  ? <ProjectActionRunIndicator run={shownRun} large />
                  : <Icon name={resolveProjectActionIconName(shown)} className="size-4" />}
              </button>
            </TooltipTrigger>
          </ContextMenuTrigger>
          <TooltipContent side="bottom">
            <div className="flex flex-col gap-0.5">
              <span>{label}</span>
              <span className="typography-micro text-muted-foreground">
                <TooltipLabelWithShortcut label={t('projectActions.header.allActions')} shortcut={allActionsShortcut} />
              </span>
            </div>
          </TooltipContent>
        </Tooltip>
        <ContextMenuContent className="w-60 max-h-[70vh] overflow-y-auto">
          <ContextMenuItem className="flex items-center gap-2" onClick={runner.openSettings}>
            <Icon name="add" className="h-4 w-4" />
            <span className="typography-ui-label text-foreground">{t('projectActions.actions.addNewAction')}</span>
          </ContextMenuItem>
          <ContextMenuSeparator />
          {runner.actions.map((entry) => (
            <ContextMenuItem
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
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
    </>
  );
};

export const HeaderProjectAction = React.memo(HeaderProjectActionComponent);

const HeaderProjectControlsComponent: React.FC<{ buttonClassName: string }> = ({ buttonClassName }) => {
  const projectActionsContext = useProjectActionsContext();
  if (!projectActionsContext) return null;
  return (
    <>
      <OpenInAppButton directory={projectActionsContext.directory} buttonClassName={buttonClassName} />
      <HeaderProjectAction buttonClassName={buttonClassName} />
    </>
  );
};

export const HeaderProjectControls = React.memo(HeaderProjectControlsComponent);
