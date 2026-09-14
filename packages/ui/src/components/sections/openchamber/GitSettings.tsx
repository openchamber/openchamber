import React from 'react';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { setFilesViewShowGitignored, useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { recordDeferredOpenCodeRestart } from '@/lib/opencode/deferredRestart';
import { useI18n } from '@/lib/i18n';
import {
  SettingsSection,
  SettingsControlGroup,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';

export const GitSettings: React.FC = () => {
  const { t } = useI18n();
  const settingsGitmojiEnabled = useConfigStore((state) => state.settingsGitmojiEnabled);
  const setSettingsGitmojiEnabled = useConfigStore((state) => state.setSettingsGitmojiEnabled);
  const showGitignored = useFilesViewShowGitignored();
  const gitChangesViewMode = useUIStore((state) => state.gitChangesViewMode);
  const setGitChangesViewMode = useUIStore((state) => state.setGitChangesViewMode);
  const agentGitAuthorityEnabled = useUIStore((state) => state.agentGitAuthorityEnabled);
  const setAgentGitAuthorityEnabled = useUIStore((state) => state.setAgentGitAuthorityEnabled);

  const [isLoading, setIsLoading] = React.useState(true);
  const viewOptions = React.useMemo(
    () => [
      { id: 'flat' as const, label: t('settings.openchamber.git.option.flatList') },
      { id: 'tree' as const, label: t('settings.openchamber.git.option.treeView') },
    ],
    [t]
  );

  // Load current settings
  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await loadDesktopSettings();
        if (data) {
          if (data.gitmojiEnabled !== undefined) {
            setSettingsGitmojiEnabled(data.gitmojiEnabled);
          }
          if (data.gitChangesViewMode !== undefined) {
            setGitChangesViewMode(data.gitChangesViewMode);
          }
        }

      } catch (error) {
        console.warn('Failed to load git settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, [setGitChangesViewMode, setSettingsGitmojiEnabled]);

  const handleGitmojiChange = React.useCallback(async (enabled: boolean) => {
    setSettingsGitmojiEnabled(enabled);
    try {
      await updateDesktopSettings({
        gitmojiEnabled: enabled,
      });
    } catch (error) {
      console.warn('Failed to save gitmoji setting:', error);
    }
  }, [setSettingsGitmojiEnabled]);

  // Written immediately, but Git in an agent shell only changes once the
  // managed OpenCode child is started again with the new environment.
  const handleAgentGitAuthorityChange = React.useCallback((enabled: boolean) => {
    setAgentGitAuthorityEnabled(enabled);
    void updateDesktopSettings({ agentGitAuthorityEnabled: enabled });
    recordDeferredOpenCodeRestart('cli', { id: 'agent-git-authority' });
  }, [setAgentGitAuthorityEnabled]);

  const handleGitChangesViewModeChange = React.useCallback((mode: 'flat' | 'tree') => {
    if (mode === gitChangesViewMode) {
      return;
    }

    setGitChangesViewMode(mode);
    void updateDesktopSettings({ gitChangesViewMode: mode });
  }, [gitChangesViewMode, setGitChangesViewMode]);

  if (isLoading) {
    return null;
  }

  return (
    <SettingsSection title={t('settings.openchamber.git.title')}>
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsControlGroup
          settingsItem="git.changes-view"
          title={t('settings.openchamber.git.changesViewTitle')}
        >
          <SettingsRadioGroup aria-label={t('settings.openchamber.git.changesViewAria')}>
            {viewOptions.map((option) => (
              <SettingsRadioOption
                key={option.id}
                selected={gitChangesViewMode === option.id}
                onSelect={() => {
                  handleGitChangesViewModeChange(option.id);
                }}
                label={option.label}
                ariaLabel={t('settings.openchamber.git.optionAria', { option: option.label })}
              />
            ))}
          </SettingsRadioGroup>
        </SettingsControlGroup>

        {/* A machine fact: it decides how Git behaves in shells this computer
            runs, so it is deliberately not something a phone can flip. */}
        <SettingsCheckboxRow
          settingsItem="git.agent-authority"
          checked={agentGitAuthorityEnabled}
          onChange={handleAgentGitAuthorityChange}
          label={t('settings.openchamber.git.agentAuthority')}
          ariaLabel={t('settings.openchamber.git.agentAuthorityAria')}
          info={t('settings.openchamber.git.agentAuthorityInfo')}
        />

        <SettingsCheckboxRow
          settingsItem="git.gitmoji"
          checked={settingsGitmojiEnabled}
          onChange={(checked) => {
            void handleGitmojiChange(checked);
          }}
          label={t('settings.openchamber.git.enableGitmoji')}
          ariaLabel={t('settings.openchamber.git.enableGitmojiAria')}
        />

        <SettingsCheckboxRow
          settingsItem="git.gitignored-files"
          checked={showGitignored}
          onChange={setFilesViewShowGitignored}
          label={t('settings.openchamber.git.showGitignored')}
          ariaLabel={t('settings.openchamber.git.showGitignoredAria')}
        />
      </div>
    </SettingsSection>
  );
};
