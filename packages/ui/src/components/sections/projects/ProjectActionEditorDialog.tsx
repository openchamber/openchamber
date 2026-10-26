import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import {
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsStackedField,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useDesktopSshStore } from '@/stores/useDesktopSshStore';
import { isDesktopShell } from '@/lib/desktop';
import {
  buildProjectActionDesktopForwardOptions,
  PROJECT_ACTION_ICONS,
} from '@/lib/projectActions';
import type { OpenChamberProjectAction, ProjectSetupSource } from '@/lib/openchamberConfig';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import { PROJECT_ACTION_PLATFORMS as PLATFORMS, projectActionIconName, type ProjectActionPlatform as Platform } from './projectSetupModel';

const NO_SSH_FORWARD = '__none__';

const createActionId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `action_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
};

export type ProjectActionEditorTarget = {
  /** Null while creating one. */
  action: OpenChamberProjectAction | null;
  source: ProjectSetupSource;
};

/**
 * One action, edited in its own dialog and written once on Save. "Saved in"
 * is a field like the others: switching it moves the action between the
 * user's settings and the repository's file.
 */
export const ProjectActionEditorDialog: React.FC<{
  target: ProjectActionEditorTarget | null;
  canShare: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (action: OpenChamberProjectAction, to: ProjectSetupSource) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}> = ({ target, canShare, onOpenChange, onSave, onDelete }) => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const isDesktopShellApp = React.useMemo(() => isDesktopShell(), []);
  const desktopSshInstances = useDesktopSshStore((state) => state.instances);
  const loadDesktopSsh = useDesktopSshStore((state) => state.load);
  const [draft, setDraft] = React.useState<OpenChamberProjectAction>({ id: '', name: '', command: '' });
  const [source, setSource] = React.useState<ProjectSetupSource>('personal');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!target) return;
    setDraft(target.action ?? { id: createActionId(), name: '', command: '', icon: 'play' });
    setSource(target.source);
  }, [target]);

  React.useEffect(() => {
    if (!isDesktopShellApp || !target) return;
    void loadDesktopSsh().catch(() => undefined);
  }, [isDesktopShellApp, loadDesktopSsh, target]);

  const desktopForwardOptions = React.useMemo(
    () => (isDesktopShellApp ? buildProjectActionDesktopForwardOptions(desktopSshInstances) : []),
    [desktopSshInstances, isDesktopShellApp],
  );

  const update = (patch: Partial<OpenChamberProjectAction>) => setDraft((current) => ({ ...current, ...patch }));
  const platforms = draft.platforms ?? [];
  const openUrl = draft.autoOpenUrl === true;
  const togglePlatform = (platform: Platform) => {
    const next = platforms.includes(platform) ? platforms.filter((entry) => entry !== platform) : [...platforms, platform];
    update({ platforms: next.length > 0 && next.length < PLATFORMS.length ? next : undefined });
  };

  const canSave = draft.name.trim().length > 0 && draft.command.trim().length > 0 && !busy && (source === 'personal' || canShare);
  const isNew = target?.action === null;

  const run = async (operation: () => Promise<boolean>) => {
    setBusy(true);
    try {
      if (await operation()) onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };

  const save = () => run(() => onSave({
    ...draft,
    name: draft.name.trim(),
    command: draft.command.trim(),
    openUrl: draft.autoOpenUrl ? draft.openUrl?.trim() || undefined : undefined,
    desktopOpenSshForward: draft.autoOpenUrl ? draft.desktopOpenSshForward : undefined,
  }, source));

  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{isNew ? t('settings.projects.actionEditor.titleNew') : t('settings.projects.actionEditor.titleEdit')}</DialogTitle>
        </DialogHeader>

        {/* Two fixed columns like the new-worktree dialog: what the action is on
            the left, how it runs on the right. One column on a phone. */}
        <div className={isMobile ? 'flex flex-col gap-5' : 'grid grid-cols-2 gap-x-10'}>
          <div className="flex min-w-0 flex-col gap-5">
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button type="button" variant="outline" size="icon" className="shrink-0" aria-label={t('settings.projects.actions.field.selectIconAria')}>
                      <Icon name={projectActionIconName(draft.icon)} className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-56 p-2">
                    <div className="grid grid-cols-6 gap-1">
                      {PROJECT_ACTION_ICONS.map((entry) => {
                        const selected = (draft.icon || 'play') === entry.key;
                        return (
                          <button
                            key={entry.key}
                            type="button"
                            onClick={() => update({ icon: entry.key })}
                            aria-pressed={selected}
                            className={cn(
                              'inline-flex h-8 w-8 items-center justify-center rounded-md text-foreground hover:bg-[var(--interactive-hover)]',
                              selected && 'bg-interactive-selection text-interactive-selection-foreground',
                            )}
                            aria-label={t('settings.projects.actions.field.iconAria', { icon: entry.label })}
                          >
                            <Icon name={entry.Icon} className="h-4 w-4" />
                          </button>
                        );
                      })}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Input
                  value={draft.name}
                  autoFocus={isNew}
                  onChange={(event) => update({ name: event.target.value })}
                  placeholder={t('settings.projects.actions.field.actionNamePlaceholder')}
                  aria-label={t('settings.projects.actions.field.actionNamePlaceholder')}
                  className="min-w-0 flex-1"
                />
              </div>
              <SettingsStackedField label={t('settings.projects.actions.field.command')} controlClassName="max-w-none">
                <Textarea
                  value={draft.command}
                  onChange={(event) => update({ command: event.target.value })}
                  placeholder={t('settings.projects.actions.field.commandPlaceholder')}
                  aria-label={t('settings.projects.actions.field.command')}
                  className="min-h-[132px] w-full font-mono text-xs"
                />
              </SettingsStackedField>
              <SettingsStackedField
                label={t('settings.projects.actionEditor.savedIn')}
                descriptionPlacement="after"
                description={(
                  // Two lines reserved, so switching between the hints keeps the height.
                  <span className="block min-h-[2lh]">
                    {!canShare && source === 'shared'
                      ? t('settings.projects.actionEditor.savedIn.teamUnavailable')
                      : source === 'shared'
                        ? t('settings.projects.actionEditor.savedIn.teamHint')
                        : t('settings.projects.actionEditor.savedIn.personalHint')}
                  </span>
                )}
              >
                <SettingsChipGroup<ProjectSetupSource>
                  value={source}
                  onChange={setSource}
                  aria-label={t('settings.projects.actionEditor.savedIn')}
                  options={[
                    { value: 'shared', label: t('settings.projects.scope.team'), disabled: !canShare && source !== 'shared' },
                    { value: 'personal', label: t('settings.projects.scope.personal') },
                  ]}
                />
              </SettingsStackedField>
          </div>
          <div className="flex min-w-0 flex-col gap-5">
              <div className="flex flex-col gap-5">
                <SettingsStackedField label={t('settings.projects.actions.runIn.label')} info={t('settings.projects.actions.runIn.info')}>
                  <SettingsChipGroup<'worktree' | 'parent'>
                    value={draft.runIn === 'parent' ? 'parent' : 'worktree'}
                    onChange={(value) => update({ runIn: value === 'parent' ? 'parent' : undefined })}
                    aria-label={t('settings.projects.actions.runIn.aria')}
                    options={[
                      { value: 'worktree', label: t('settings.projects.actions.runIn.worktree') },
                      { value: 'parent', label: t('settings.projects.actions.runIn.project') },
                    ]}
                  />
                </SettingsStackedField>

                <SettingsStackedField label={t('settings.projects.actionEditor.platforms')}>
                  <div role="group" aria-label={t('settings.projects.actionEditor.platforms')} className="flex flex-wrap items-center gap-1">
                    <Button type="button" variant="chip" size="xs" className="!font-normal" aria-pressed={platforms.length === 0} onClick={() => update({ platforms: undefined })}>
                      {t('settings.projects.actionEditor.platformsAll')}
                    </Button>
                    {PLATFORMS.map((platform) => (
                      <Button
                        key={platform.value}
                        type="button"
                        variant="chip"
                        size="xs"
                        className="!font-normal"
                        aria-pressed={platforms.includes(platform.value)}
                        onClick={() => togglePlatform(platform.value)}
                      >
                        {platform.label}
                      </Button>
                    ))}
                  </div>
                </SettingsStackedField>
              </div>
              <div className="space-y-2">
                <SettingsCheckboxRow
                  checked={draft.autoOpenUrl === true}
                  onChange={(checked) => update({ autoOpenUrl: checked ? true : undefined })}
                  label={t('settings.projects.actionEditor.openUrl')}
                  info={t('settings.projects.actions.field.overrideUrlTooltip')}
                />
                {/* Always laid out, only disabled while off: switching it must not
                    change the dialog's height. */}
                <div className="space-y-2 ps-6">
                  <Input
                    value={draft.openUrl ?? ''}
                    disabled={!openUrl}
                    onChange={(event) => update({ openUrl: event.target.value })}
                    placeholder={t('settings.projects.actions.field.overrideUrlPlaceholder')}
                    aria-label={t('settings.projects.actions.field.overrideUrlPlaceholder')}
                    className="w-full font-mono text-xs"
                  />
                  <p className={cn(SETTINGS_HELPER_CLASS, !openUrl && 'opacity-60')}>{t('settings.projects.actions.field.overrideUrlVariables')}</p>
                  {isDesktopShellApp ? (
                    <Select
                      value={draft.desktopOpenSshForward && desktopForwardOptions.some((entry) => entry.id === draft.desktopOpenSshForward) ? draft.desktopOpenSshForward : NO_SSH_FORWARD}
                      onValueChange={(value) => update({ desktopOpenSshForward: value === NO_SSH_FORWARD ? undefined : value })}
                      disabled={!openUrl || desktopForwardOptions.length === 0}
                    >
                      <SelectTrigger className="w-full" aria-label={t('settings.projects.actions.field.desktopSshForward')}>
                        <SelectValue>
                          {(value) => (desktopForwardOptions.length === 0
                            ? t('settings.projects.actions.state.noDesktopSshForwards')
                            : desktopForwardOptions.find((entry) => entry.id === value)?.label ?? t('settings.projects.actions.field.useOutputManualUrl'))}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NO_SSH_FORWARD}>{t('settings.projects.actions.field.useOutputManualUrl')}</SelectItem>
                        {desktopForwardOptions.map((entry) => (
                          <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                </div>
              </div>
          </div>
        </div>

        <DialogFooter className="sm:justify-between">
          {!isNew ? (
            <Button type="button" size="sm" variant="ghost" className="text-[var(--status-error)]" disabled={busy} onClick={() => void run(onDelete)}>
              {target?.source === 'shared' ? t('settings.projects.actions.menu.deleteForEveryone') : t('settings.projects.actions.menu.delete')}
            </Button>
          ) : <span />}
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" size="sm" variant="outline" onClick={() => onOpenChange(false)}>{t('dialog.common.actions.cancel')}</Button>
            <Button type="button" size="sm" disabled={!canSave} onClick={() => void save()}>{t('settings.projects.actionEditor.save')}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
