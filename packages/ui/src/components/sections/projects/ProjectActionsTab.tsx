import React from 'react';
import { toast } from '@/components/ui';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SettingsCardPill, type SettingsCardAction } from '@/components/sections/shared/SettingsCards';
import { cn } from '@/lib/utils';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import type { ProjectSetup } from '@/lib/openchamberConfig';
import { useI18n } from '@/lib/i18n';
import { ProjectActionEditorDialog, type ProjectActionEditorTarget } from './ProjectActionEditorDialog';
import { ProjectScopeChip, ProjectSetupUnavailable } from './ProjectSettingsBits';
import {
  PROJECT_ACTION_PLATFORMS,
  projectActionIconName,
  canWriteShared,
  deleteProjectAction,
  listProjectActions,
  saveProjectAction,
  setSharedActionHidden,
  type ProjectActionEntry,
} from './projectSetupModel';
import type { ProjectSetupState } from './useProjectSetup';

const ActionsGrid: React.FC<{ setup: ProjectSetup; setupState: ProjectSetupState }> = ({ setup, setupState }) => {
  const { t } = useI18n();
  const { write, reload } = setupState;
  const { confirm, dialog: confirmDialog } = useConfirmDialog();
  const [editing, setEditing] = React.useState<{ target: ProjectActionEditorTarget; entry: ProjectActionEntry | null } | null>(null);
  const entries = listProjectActions(setup);
  const shareable = canWriteShared(setup);

  // Every change ends with a fresh read, so the grid shows what is on disk
  // even after a move whose second write failed.
  const settle = async (ok: boolean): Promise<boolean> => {
    if (!ok) toast.error(t('settings.projects.actions.toast.saveFailed'));
    await reload();
    return ok;
  };

  const remove = async (entry: ProjectActionEntry): Promise<boolean> => {
    if (entry.source === 'shared') {
      const confirmed = await confirm({
        title: t('settings.projects.actions.confirmDelete.title', { name: entry.action.name }),
        message: t('settings.projects.actions.confirmDelete.message'),
        action: t('settings.projects.actions.menu.delete'),
        destructive: true,
      });
      if (!confirmed) return false;
    }
    return settle(await deleteProjectAction(setup, write, entry));
  };

  const menuFor = (entry: ProjectActionEntry): SettingsCardAction[] => {
    if (entry.source === 'personal') {
      return [{ label: t('settings.projects.actions.menu.delete'), icon: 'delete-bin', destructive: true, onSelect: () => void remove(entry) }];
    }
    const items: SettingsCardAction[] = [{
      label: entry.hidden ? t('settings.projects.actions.menu.show') : t('settings.projects.shared.actions.hide'),
      icon: entry.hidden ? 'eye' : 'eye-off',
      onSelect: () => void setSharedActionHidden(setup, write, entry.action.id, !entry.hidden).then(settle),
    }];
    if (shareable) {
      items.push({ label: t('settings.projects.actions.menu.deleteForEveryone'), icon: 'delete-bin', destructive: true, onSelect: () => void remove(entry) });
    }
    return items;
  };

  return (
    <>
      {setup.shared.status === 'invalid' ? (
        <p className="mb-3 typography-meta text-[var(--status-warning)]">
          {t('settings.projects.shared.invalid', { path: setup.shared.path, reason: setup.shared.reason ?? '' })}
        </p>
      ) : null}
      {/* One quiet list: the name and command say what an action is, the
          chip says where it lives; everything else is in the editor. */}
      <ul className="max-w-[44rem] divide-y divide-[var(--interactive-border)] overflow-hidden rounded-xl border border-[var(--interactive-border)]">
        {entries.map((entry) => {
          const platforms = entry.action.platforms ?? [];
          return (
            <li key={`${entry.source}:${entry.action.id}`} className="flex items-center gap-2 pe-2 transition-colors hover:bg-[var(--interactive-hover)]">
              <button
                type="button"
                onClick={() => setEditing({ target: { action: entry.action, source: entry.source }, entry })}
                className="flex min-w-0 flex-1 items-center gap-3 py-2 ps-3 text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
              >
                <Icon name={projectActionIconName(entry.action.icon)} className={cn('size-4 shrink-0 text-muted-foreground', entry.hidden && 'opacity-60')} />
                <span className={cn('min-w-0 flex-1', entry.hidden && 'opacity-60')}>
                  <span className="block truncate typography-ui-label text-foreground">{entry.action.name}</span>
                  <span className="block truncate font-mono typography-micro text-muted-foreground" title={entry.action.command}>{entry.action.command}</span>
                </span>
                {platforms.length > 0 ? (
                  <span className="hidden shrink-0 typography-micro text-muted-foreground @xl:inline">
                    {platforms.map((value) => PROJECT_ACTION_PLATFORMS.find((platform) => platform.value === value)?.label ?? value).join(', ')}
                  </span>
                ) : null}
                {entry.hidden ? <SettingsCardPill tone="neutral">{t('settings.projects.actions.hiddenBadge')}</SettingsCardPill> : null}
                <ProjectScopeChip source={entry.source} />
              </button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label={t('settings.projects.actions.menuAria')}>
                    <Icon name="more-2" className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-fit min-w-40">
                  {menuFor(entry).map((item) => (
                    <DropdownMenuItem key={item.label} variant={item.destructive ? 'destructive' : 'default'} onClick={item.onSelect}>
                      {item.icon ? <Icon name={item.icon} className="size-4" /> : null}
                      {item.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={() => setEditing({ target: { action: null, source: 'personal' }, entry: null })}
            className="flex w-full items-center gap-3 py-2.5 ps-3 text-start typography-ui-label text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
          >
            <Icon name="add" className="size-4 shrink-0" />
            {t('settings.projects.actions.new')}
          </button>
        </li>
      </ul>
      <ProjectActionEditorDialog
        target={editing?.target ?? null}
        canShare={shareable}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSave={async (action, to) => settle(await saveProjectAction(setup, write, action, editing?.entry?.source ?? null, to))}
        onDelete={async () => (editing?.entry ? remove(editing.entry) : false)}
      />
      {confirmDialog}
    </>
  );
};

export const ProjectActionsTab: React.FC<{ setupState: ProjectSetupState }> = ({ setupState }) => {
  const { t } = useI18n();
  return (
    <SettingsSection
      title={t('settings.projects.actions.title')}
      info={t('settings.projects.actions.info')}
      settingsItem="projects.actions"
      divider={false}
    >
      {setupState.load.state === 'ready'
        ? <ActionsGrid setup={setupState.load.setup} setupState={setupState} />
        : <ProjectSetupUnavailable setupState={setupState} />}
    </SettingsSection>
  );
};
