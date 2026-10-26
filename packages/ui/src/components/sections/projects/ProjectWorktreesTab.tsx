import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SettingsCardPill } from '@/components/sections/shared/SettingsCards';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import {
  SettingsCheckboxRow,
  SettingsSection,
  SETTINGS_HELPER_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { checkIsGitRepository } from '@/lib/gitApi';
import { saveWorktreeSetupWaitEnabled, updateProjectSetup, type ProjectRef, type ProjectSetup } from '@/lib/openchamberConfig';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ProjectScopeChip, ProjectSetupUnavailable } from './ProjectSettingsBits';
import {
  addSetupCommand,
  canWriteShared,
  editSetupCommand,
  listSetupCommands,
  moveSetupCommand,
  removeSetupCommand,
} from './projectSetupModel';
import type { ProjectSetupState } from './useProjectSetup';

/** A command's text, edited in place and written when the field loses focus. */
const CommandInput: React.FC<{
  value: string;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  ariaLabel: string;
  onCommit: (text: string) => void;
}> = ({ value, disabled, autoFocus, placeholder, ariaLabel, onCommit }) => {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  return (
    <Input
      value={draft}
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
        if (event.key === 'Escape') {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      className="min-w-0 flex-1 font-mono text-xs"
    />
  );
};

const SetupCommands: React.FC<{ projectRef: ProjectRef; setup: ProjectSetup; setupState: ProjectSetupState }> = ({ projectRef, setup, setupState }) => {
  const { t } = useI18n();
  const { write, reload } = setupState;
  const [adding, setAdding] = React.useState(false);
  const [wait, setWait] = React.useState(setup.setupWorktreeWait);
  React.useEffect(() => setWait(setup.setupWorktreeWait), [setup.setupWorktreeWait]);
  const entries = listSetupCommands(setup);
  const shareable = canWriteShared(setup);
  const replaceMode = setup.personal.setupWorktreeMode === 'replace';

  const settle = async (ok: boolean) => {
    if (!ok) toast.error(t('settings.openchamber.worktrees.setup.toast.saveFailed'));
    await reload();
  };

  return (
    <div className="space-y-4">
      {entries.length > 0 ? (
        <ol className="max-w-[40rem] space-y-1.5">
          {entries.map((entry, position) => {
            const editable = entry.source === 'personal' || shareable;
            return (
              <li key={`${entry.source}:${entry.index}:${entry.command}`} className={cn('flex items-center gap-2', entry.skipped && 'opacity-60')}>
                <span className="w-4 shrink-0 text-end typography-meta tabular-nums text-muted-foreground">{position + 1}</span>
                <CommandInput
                  value={entry.command}
                  disabled={!editable}
                  ariaLabel={t('settings.projects.worktrees.commandAria', { position: position + 1 })}
                  onCommit={(text) => void editSetupCommand(setup, write, entry, text).then(settle)}
                />
                {entry.skipped ? (
                  <SettingsCardPill tone="neutral">{t('settings.projects.worktrees.skipped')}</SettingsCardPill>
                ) : (
                  <ProjectScopeChip source={entry.source} />
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0 text-muted-foreground" aria-label={t('settings.projects.worktrees.commandMenuAria')} disabled={!editable}>
                      <Icon name="more-2" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-fit min-w-40">
                    {shareable ? (
                      <DropdownMenuItem onClick={() => void moveSetupCommand(setup, write, entry).then(settle)}>
                        {entry.source === 'shared' ? t('settings.projects.shared.actions.makePersonal') : t('settings.projects.shared.actions.share')}
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem variant="destructive" onClick={() => void removeSetupCommand(setup, write, entry).then(settle)}>
                      {entry.source === 'shared' ? t('settings.projects.worktrees.removeForEveryone') : t('settings.openchamber.worktrees.setup.removeCommandAria')}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </li>
            );
          })}
        </ol>
      ) : null}

      {adding ? (
        <div className="flex max-w-[40rem] items-center gap-2 ps-6">
          <CommandInput
            value=""
            autoFocus
            placeholder={t('settings.openchamber.worktrees.setup.commandPlaceholder')}
            ariaLabel={t('settings.openchamber.worktrees.setup.addCommand')}
            onCommit={(text) => {
              setAdding(false);
              if (text.trim()) void addSetupCommand(setup, write, text).then(settle);
            }}
          />
        </div>
      ) : (
        <Button type="button" variant="ghost" size="xs" className="!font-normal" onClick={() => setAdding(true)}>
          <Icon name="add" className="h-3.5 w-3.5" />
          {t('settings.openchamber.worktrees.setup.addCommand')}
        </Button>
      )}

      <div className={SETTINGS_OPTION_STACK_CLASS}>
        {setup.shared.setupWorktree.length > 0 ? (
          <SettingsCheckboxRow
            settingsItem="projects.worktree.setup.replace"
            checked={replaceMode}
            onChange={(next) => void updateProjectSetup(projectRef, { setupWorktreeMode: next ? 'replace' : 'append' }).then(settle)}
            label={t('settings.projects.shared.replaceMode')}
          />
        ) : null}
        <SettingsCheckboxRow
          settingsItem="projects.worktree.setup.wait"
          checked={wait}
          onChange={(next) => {
            setWait(next);
            void saveWorktreeSetupWaitEnabled(projectRef, next).then(settle);
          }}
          label={t('settings.openchamber.worktrees.setup.waitForCommands')}
        />
      </div>
    </div>
  );
};

export const ProjectWorktreesTab: React.FC<{
  projectRef: ProjectRef;
  setupState: ProjectSetupState;
  /** Opens the project's worktrees page; absent where that page does not exist. */
  onOpenWorktrees?: () => void;
}> = ({ projectRef, setupState, onOpenWorktrees }) => {
  const { t } = useI18n();
  const [isGitRepo, setIsGitRepo] = React.useState<boolean | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setIsGitRepo(null);
    checkIsGitRepository(projectRef.path)
      .then((result) => {
        if (!cancelled) setIsGitRepo(result);
      })
      // An unknown answer keeps the setup editable, as before the check existed.
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [projectRef.path]);

  if (isGitRepo === false) {
    return (
      <SettingsSection title={t('settings.openchamber.worktrees.setup.title')} settingsItem="projects.worktree" divider={false}>
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.openchamber.worktrees.state.gitOnly')}</p>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        title={t('settings.openchamber.worktrees.setup.title')}
        settingsItem="projects.worktree"
        divider={false}
        titleAccessory={(
          <SettingsInfoHint>
            {t('settings.openchamber.worktrees.setup.tooltipPrefix')}
            {' '}
            <code className="rounded bg-sidebar-accent/50 px-1 font-mono text-xs">$ROOT_PROJECT_PATH</code>
            {' '}
            {t('settings.openchamber.worktrees.setup.tooltipSuffix')}
          </SettingsInfoHint>
        )}
      >
        {setupState.load.state === 'ready'
          ? <SetupCommands projectRef={projectRef} setup={setupState.load.setup} setupState={setupState} />
          : <ProjectSetupUnavailable setupState={setupState} />}
      </SettingsSection>

      {onOpenWorktrees ? (
        <SettingsSection title={t('settings.projects.worktrees.manageTitle')}>
          <div className="flex flex-wrap items-center gap-3">
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.projects.worktrees.manageDescription')}</p>
            <Button type="button" variant="outline" size="sm" onClick={onOpenWorktrees}>
              {t('sessions.sidebar.project.actions.manageWorktrees')}
              <Icon name="arrow-right-s" className="h-4 w-4" />
            </Button>
          </div>
        </SettingsSection>
      ) : null}
    </>
  );
};
