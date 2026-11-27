import React from 'react';
import { Switch } from '@/components/ui/switch';
import { SettingsNewBadge } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n } from '@/lib/i18n';
import { useMcpSkillsSetting } from '@/hooks/useMcpSkillsSetting';

export const McpSkillsToggle: React.FC<{ onChanged: () => void }> = ({ onChanged }) => {
  const { t } = useI18n();
  const { enabled, pending, save } = useMcpSkillsSetting(onChanged);
  const inactive = enabled === null || pending;

  const toggle = () => {
    if (inactive) return;
    void save(!enabled);
  };

  return (
    <div
      data-settings-item="skills.mcp"
      role="switch"
      aria-checked={enabled === true}
      aria-disabled={inactive || undefined}
      aria-label={t('settings.skills.sidebar.mcpSkills')}
      tabIndex={inactive ? -1 : 0}
      className={`flex items-center gap-2 rounded-sm py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${inactive ? 'cursor-default' : 'cursor-pointer'}`}
      onClick={toggle}
      onKeyDown={(event) => {
        if (event.key === ' ' || event.key === 'Enter') {
          event.preventDefault();
          toggle();
        }
      }}
    >
      <span className="min-w-0 flex-1 truncate typography-ui-label text-muted-foreground">
        {t('settings.skills.sidebar.mcpSkills')}
      </span>
      <SettingsNewBadge items={['skills.mcp']} />
      <SettingsInfoHint>{t('settings.skills.sidebar.mcpSkillsInfo')}</SettingsInfoHint>
      <Switch
        size="sm"
        checked={enabled === true}
        loading={pending}
        disabled={inactive}
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none"
      />
    </div>
  );
};
