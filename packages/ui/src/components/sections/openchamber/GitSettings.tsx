import React from 'react';
import { Textarea } from '@/components/ui/textarea';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { normalizeInsecureGitOrigin } from '@/lib/settings/parsers';
import { useConfigStore } from '@/stores/useConfigStore';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useUIStore } from '@/stores/useUIStore';
import { setFilesViewShowGitignored, useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { useI18n } from '@/lib/i18n';
import {
  SettingsSection,
  SettingsStackedField,
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
    <>
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
      <GitInsecureOriginsSection />
    </>
  );
};

/**
 * The user's own plain-HTTP Git allowlist. The box holds raw text while typing;
 * only whole origins the server's check accepts persist (the registry's parser
 * drops the rest) and a line that isn't one is called out below the box.
 * Enterprise mode hides the section entirely: widening plaintext trust is the
 * administrator's move, made in the policy file.
 */
const GitInsecureOriginsSection: React.FC = () => {
  const { t } = useI18n();
  const enterpriseMode = useEnterpriseMode();
  const originsText = useUIStore((state) => state.allowedInsecureGitOrigins);
  const setOriginsText = useUIStore((state) => state.setAllowedInsecureGitOrigins);

  const typedLines = React.useMemo(
    () => originsText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
    [originsText],
  );
  const invalidLines = React.useMemo(
    () => typedLines.filter((line) => !normalizeInsecureGitOrigin(line)),
    [typedLines],
  );

  if (enterpriseMode) return null;

  return (
    <SettingsSection
      title={t('settings.openchamber.git.insecureTitle')}
      info={t('settings.openchamber.git.insecureInfo')}
      settingsItem="git.insecure-origins"
      contentClassName="space-y-3"
    >
      <SettingsStackedField
        label={t('settings.openchamber.git.insecureLabel')}
        description={invalidLines.length > 0
          ? t('settings.openchamber.git.insecureInvalid', { count: invalidLines.length })
          : t('settings.openchamber.git.insecureSyntax')}
        descriptionPlacement="after"
        controlClassName="block max-w-none"
      >
        <Textarea
          value={originsText}
          onChange={(event) => setOriginsText(event.target.value)}
          placeholder={'http://git.internal\nhttp://git.internal:8443'}
          aria-label={t('settings.openchamber.git.insecureLabel')}
          rows={3}
          spellCheck={false}
          className="w-full font-mono typography-meta"
        />
      </SettingsStackedField>
    </SettingsSection>
  );
};
