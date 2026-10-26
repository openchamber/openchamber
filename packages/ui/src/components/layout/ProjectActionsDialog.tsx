import React from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Icon } from '@/components/icon/Icon';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import type { OpenChamberProjectAction } from '@/lib/openchamberConfig';
import { useObserveProjectActionRuns, useProjectActions } from './projectActionsRunnerContext';
import { ProjectActionRunIndicator } from './ProjectActionRunIndicator';
import { resolveProjectActionIconName } from '@/lib/projectActions';

const CONFIGURE_ITEM_VALUE = '__configure_project_actions__';

/**
 * The current project's actions, from the keyboard: Enter runs an idle action
 * and stops a running one. It opens on the action the Work Status row shows,
 * so the shortcut and Enter repeat the last run.
 */
export const ProjectActionsDialog: React.FC = () => {
  const { t } = useI18n();
  const open = useUIStore((state) => state.isProjectActionsDialogOpen);
  const setOpen = useUIStore((state) => state.setProjectActionsDialogOpen);
  const runner = useProjectActions();
  useObserveProjectActionRuns(open);

  // Set on opening only: moving the highlight while the user navigates would fight them.
  const [highlighted, setHighlighted] = React.useState('');
  const [wasOpen, setWasOpen] = React.useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setHighlighted(runner?.shown?.id ?? '');
  }

  const actOn = (action: OpenChamberProjectAction) => {
    if (!runner) return;
    setOpen(false);
    runner.select(action);
    runner.toggle(action);
  };

  const configure = () => {
    setOpen(false);
    runner?.openSettings();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogHeader className="sr-only">
        <DialogTitle>{t('projectActions.dialog.title')}</DialogTitle>
        <DialogDescription>{t('projectActions.dialog.description')}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className="gap-0 overflow-hidden p-0 max-w-[min(480px,calc(100vw-2rem))]"
        layerClassName="items-start pt-[12vh]"
        showCloseButton={false}
      >
        <Command
          value={highlighted}
          onValueChange={setHighlighted}
          className="[&_[cmdk-group]]:px-2 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1.5 [&_[cmdk-item]]:typography-meta"
        >
          <CommandInput placeholder={t('projectActions.dialog.placeholder')} />
          <CommandList>
            {runner?.available ? (
              <>
                <CommandEmpty>{t('projectActions.dialog.empty')}</CommandEmpty>
                <CommandGroup>
                  {runner.actions.map((entry) => {
                    const run = runner.runOf(entry);
                    return (
                      <CommandItem
                        key={entry.id}
                        value={entry.id}
                        keywords={[entry.name]}
                        disabled={run?.status === 'stopping'}
                        onSelect={() => actOn(entry)}
                        aria-label={run
                          ? t('projectActions.actions.stopNamedAria', { name: entry.name })
                          : t('projectActions.actions.runNamedAria', { name: entry.name })}
                      >
                        <Icon name={resolveProjectActionIconName(entry)} className="size-4" />
                        <span className="min-w-0 truncate">{entry.name}</span>
                        {entry.source === 'shared' ? (
                          <span className="shrink-0 typography-micro px-1 rounded leading-none pb-px text-muted-foreground bg-[var(--surface-subtle)]">
                            {t('projectActions.menu.sharedBadge')}
                          </span>
                        ) : null}
                        <ProjectActionRunIndicator run={run} showIdle className="ms-auto" />
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
                <CommandGroup>
                  <CommandItem
                    value={CONFIGURE_ITEM_VALUE}
                    keywords={[t('projectActions.dialog.configure')]}
                    onSelect={configure}
                  >
                    <Icon name="settings-3" className="size-4" />
                    <span className="truncate">{t('projectActions.dialog.configure')}</span>
                  </CommandItem>
                </CommandGroup>
              </>
            ) : (
              <div className="px-4 py-6 text-center typography-meta text-muted-foreground">
                {t('projectActions.dialog.noProject')}
              </div>
            )}
          </CommandList>
          <div className="flex items-center gap-4 border-t border-border px-3 py-1.5 typography-micro text-muted-foreground" aria-hidden="true">
            <span><kbd className="font-sans">↑↓</kbd> {t('commandPalette.footer.navigate')}</span>
            <span><kbd className="font-sans">↵</kbd> {t('projectActions.dialog.footer.toggle')}</span>
            <span><kbd className="font-sans">esc</kbd> {t('commandPalette.footer.close')}</span>
          </div>
        </Command>
      </DialogContent>
    </Dialog>
  );
};
