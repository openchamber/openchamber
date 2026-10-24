import React from 'react';
import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

/** When a worktree whose work is over gets archived: on Done, and after its PR is merged. Both off by default. */
export const FinishedWorktreesSettings: React.FC = () => {
  const { t } = useI18n();
  const archiveOnDone = useUIStore((state) => state.worktreeArchiveOnDoneEnabled);
  const setArchiveOnDone = useUIStore((state) => state.setWorktreeArchiveOnDoneEnabled);
  const archiveOnMerge = useUIStore((state) => state.mergedWorktreeCleanupEnabled);
  const setArchiveOnMerge = useUIStore((state) => state.setMergedWorktreeCleanupEnabled);

  return (
    <SettingsSection
      settingsItem="sessions.finished-worktrees-section"
      title={t('settings.openchamber.finishedWorktrees.title')}
      info={t('settings.openchamber.finishedWorktrees.info')}
    >
      <SettingsCheckboxRow
        settingsItem="sessions.worktree-archive-on-done"
        checked={archiveOnDone}
        onChange={setArchiveOnDone}
        label={t('settings.openchamber.finishedWorktrees.field.archiveOnDone')}
      />
      <SettingsCheckboxRow
        settingsItem="sessions.merged-worktree-cleanup"
        checked={archiveOnMerge}
        onChange={setArchiveOnMerge}
        label={t('settings.openchamber.mergedWorktreeCleanup.field.enable')}
      />
    </SettingsSection>
  );
};
