import React from 'react';
import { SettingsCheckboxRow } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useMcpSkillsSetting } from '@/hooks/useMcpSkillsSetting';

export const McpSkillsCheckbox: React.FC<{ onChanged: () => void }> = ({ onChanged }) => {
  const { t } = useI18n();
  const { enabled, save } = useMcpSkillsSetting(onChanged);

  return (
    <SettingsCheckboxRow
      settingsItem="skills.mcp"
      checked={enabled ?? false}
      disabled={enabled === null}
      onChange={(checked) => {
        void save(checked);
      }}
      label={t('settings.skills.sidebar.mcpSkills')}
      info={t('settings.skills.sidebar.mcpSkillsInfo')}
    />
  );
};
