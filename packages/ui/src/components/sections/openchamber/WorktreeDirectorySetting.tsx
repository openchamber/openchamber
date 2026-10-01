import React from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import {
  SettingsControlGroup,
  SettingsFieldRow,
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useWorktreeDirectoryStore } from '@/stores/useWorktreeDirectoryStore';

/** Which configuration document the effective value came from, in the user's terms. */
const WORKTREE_DIRECTORY_SOURCE_KEYS = {
  custom: 'settings.openchamber.git.worktreeDirectorySourceCustom',
  project: 'settings.openchamber.git.worktreeDirectorySourceProject',
  global: 'settings.openchamber.git.worktreeDirectorySourceGlobal',
} as const;

/**
 * Where new worktrees land. The value is OpenCode's `worktree.directory`, resolved on the
 * runtime that owns the repository, so a linked checkout or a remote session never decides
 * the path. Leave it empty to keep OpenChamber's default folder inside its data directory.
 */
export const WorktreeDirectorySetting: React.FC = () => {
  const { t } = useI18n();
  const state = useWorktreeDirectoryStore((s) => s.state);
  const load = useWorktreeDirectoryStore((s) => s.load);
  const save = useWorktreeDirectoryStore((s) => s.save);
  const [draft, setDraft] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);

  const snapshot = state.kind === 'ready' ? state.snapshot : null;
  const savedValue = snapshot?.directory ?? '';

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    setDraft(savedValue);
  }, [savedValue]);

  const commit = React.useCallback(async () => {
    const next = draft.trim();
    if (!snapshot || next === savedValue) return;
    setIsSaving(true);
    try {
      await save(next || null);
    } finally {
      setIsSaving(false);
    }
  }, [draft, save, savedValue, snapshot]);

  const reset = React.useCallback(() => {
    if (!savedValue) return;
    setDraft('');
    setIsSaving(true);
    void save(null).finally(() => setIsSaving(false));
  }, [save, savedValue]);

  if (!snapshot) {
    return (
      <SettingsControlGroup
        title={t('settings.openchamber.git.worktreeDirectoryGroup')}
        description={state.kind === 'failed' ? t('settings.openchamber.git.worktreeDirectoryFailed') : undefined}
        settingsItem="git.worktree-directory"
      >
        <SettingsFieldRow label={t('settings.openchamber.git.worktreeDirectory')} settingsItem="git.worktree-directory">
          <Input
            value=""
            readOnly
            disabled
            placeholder={t('settings.openchamber.git.worktreeDirectoryPlaceholder')}
            aria-label={t('settings.openchamber.git.worktreeDirectoryAria')}
            className="h-8 rounded-md px-3 font-mono text-xs"
          />
        </SettingsFieldRow>
      </SettingsControlGroup>
    );
  }

  const scopeLabel = snapshot.source && snapshot.path
    ? t(WORKTREE_DIRECTORY_SOURCE_KEYS[snapshot.source], { path: snapshot.path })
    : t('settings.openchamber.git.worktreeDirectoryUnset');

  return (
    <SettingsControlGroup
      title={t('settings.openchamber.git.worktreeDirectoryGroup')}
      description={t('settings.openchamber.git.worktreeDirectoryDescription')}
      settingsItem="git.worktree-directory"
    >
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsFieldRow
          label={t('settings.openchamber.git.worktreeDirectory')}
          info={t('settings.openchamber.git.worktreeDirectoryInfo')}
          settingsItem="git.worktree-directory"
        >
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            placeholder={t('settings.openchamber.git.worktreeDirectoryPlaceholder')}
            aria-label={t('settings.openchamber.git.worktreeDirectoryAria')}
            disabled={isSaving || snapshot.locked}
            className="h-8 rounded-md px-3 font-mono text-xs"
          />
          {savedValue && !snapshot.locked ? (
            <Button
              size="icon"
              variant="ghost"
              className={SETTINGS_ICON_BUTTON_CLASS}
              onClick={reset}
              disabled={isSaving}
              aria-label={t('settings.openchamber.git.worktreeDirectoryResetAria')}
              title={t('settings.common.actions.reset')}
            >
              <Icon name="restart" className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </SettingsFieldRow>

        <div className="min-w-0 space-y-0.5">
          <p className="typography-meta break-all text-muted-foreground">
            {snapshot.locked ? t('settings.openchamber.git.worktreeDirectoryLocked', { path: snapshot.path ?? '' }) : scopeLabel}
          </p>
          {!snapshot.locked && snapshot.writePath ? (
            <p className="typography-meta break-all text-muted-foreground/70">
              {t('settings.openchamber.git.worktreeDirectoryWritesTo', { path: snapshot.writePath })}
            </p>
          ) : null}
        </div>
      </div>
    </SettingsControlGroup>
  );
};
