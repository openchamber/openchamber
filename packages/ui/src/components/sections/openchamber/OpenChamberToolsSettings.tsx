import * as React from 'react';

import {
  SettingsSection,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { recordDeferredOpenCodeRestart } from '@/lib/opencode/deferredRestart';
import { updateDesktopSettings } from '@/lib/persistence';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';

/**
 * Which OpenChamber capabilities agents are given.
 *
 * Each entry is one tool the managed OpenCode child is handed, so the choices
 * belong together and not under the CLI's own configuration — the binary path
 * is about which OpenCode runs, these are about what it can do.
 *
 * A toggle is written immediately but only reaches agents once OpenCode
 * restarts, so each one records a pending restart rather than implying the
 * change is already live.
 */
export const OpenChamberToolsSettings: React.FC = () => {
  const { t } = useI18n();
  const agentControlToolEnabled = useUIStore((state) => state.agentControlToolEnabled);
  const setAgentControlToolEnabled = useUIStore((state) => state.setAgentControlToolEnabled);
  const agentWebToolEnabled = useUIStore((state) => state.agentWebToolEnabled);
  const setAgentWebToolEnabled = useUIStore((state) => state.setAgentWebToolEnabled);

  const handleAgentControlToolChange = React.useCallback((enabled: boolean) => {
    setAgentControlToolEnabled(enabled);
    void updateDesktopSettings({ agentControlToolEnabled: enabled });
    recordDeferredOpenCodeRestart('cli', { id: 'agent-control-tool' });
  }, [setAgentControlToolEnabled]);

  const handleAgentWebToolChange = React.useCallback((enabled: boolean) => {
    setAgentWebToolEnabled(enabled);
    void updateDesktopSettings({ agentWebToolEnabled: enabled });
    recordDeferredOpenCodeRestart('cli', { id: 'agent-web-tool' });
  }, [setAgentWebToolEnabled]);

  return (
    <SettingsSection title={t('settings.openchamber.tools.title')}>
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsCheckboxRow
          settingsItem="sessions.agent-control-tool"
          checked={agentControlToolEnabled}
          onChange={handleAgentControlToolChange}
          label={t('settings.openchamber.tools.field.agentControlTool')}
          ariaLabel={t('settings.openchamber.tools.field.agentControlToolAria')}
          info={t('settings.openchamber.tools.field.agentControlToolInfo')}
        />

        <SettingsCheckboxRow
          settingsItem="sessions.agent-web-tool"
          checked={agentWebToolEnabled}
          onChange={handleAgentWebToolChange}
          label={t('settings.openchamber.tools.field.agentWebTool')}
          ariaLabel={t('settings.openchamber.tools.field.agentWebToolAria')}
          info={t('settings.openchamber.tools.field.agentWebToolInfo')}
        />
      </div>
    </SettingsSection>
  );
};
