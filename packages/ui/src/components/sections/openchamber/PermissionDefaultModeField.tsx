import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
  SettingsChipGroup,
  SettingsFieldRow,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { JevAccessNote, SettingsInlineLink } from '@/components/sections/classification/JevAccessNote';
import { openClassificationProviders, useClassifierSourceName } from '@/components/sections/classification/classifierSources';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { useAgentsStore } from '@/stores/useAgentsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import { useUIStore } from '@/stores/useUIStore';
import { displayedPermissionMode, type PermissionMode } from '@/stores/utils/permissionAutoAccept';

/** The composer's shield, so the setting and the button read as one thing. */
const MODE_ICON = {
  ask: { icon: 'shield-user', color: undefined },
  safety: { icon: 'shield-star', color: 'var(--status-success)' },
  auto: { icon: 'shield-check', color: 'var(--status-info)' },
} satisfies Record<PermissionMode, { icon: IconName; color: string | undefined }>;

interface PermissionDefaultModeFieldProps {
  /** The default agent on this page; its permissions decide what "Ask" covers. */
  agentName?: string;
}

/**
 * The permission mode the server writes onto each new top-level session, as
 * three chips. Each explains itself on hover and the chosen one below the
 * row, with a link to where its behaviour is configured: agent permissions for
 * Ask and Accept, classification providers for the safety net. The safety net
 * chip is disabled while no classification provider can run it, and a saved
 * `safety` default then shows as Ask, which is what such a session does. VS
 * Code has no server to apply a default, so this row is not shown there.
 */
export const PermissionDefaultModeField: React.FC<PermissionDefaultModeFieldProps> = ({ agentName }) => {
  const { t } = useI18n();
  const mode = useUIStore((state) => state.permissionDefaultMode);
  const setMode = useUIStore((state) => state.setPermissionDefaultMode);
  const safetyAvailable = useRoutingStore(selectSafetyNetAvailable);
  const providerName = useClassifierSourceName(useRoutingStore((state) => state.classifier?.effective ?? null));
  const shown = displayedPermissionMode(mode, safetyAvailable);

  const handleChange = React.useCallback((value: PermissionMode) => {
    setMode(value);
    void updateDesktopSettings({ permissionDefaultMode: value });
  }, [setMode]);

  const openAgentPermissions = React.useCallback(() => {
    const agent = agentName ?? useConfigStore.getState().currentAgentName;
    if (agent) useAgentsStore.getState().setSelectedAgent(agent);
    useUIStore.getState().requestSettingsJump('agents', 'agents.permissions');
  }, [agentName]);

  const explanation = (value: PermissionMode): React.ReactNode => {
    // The disabled chip says why and where to fix it.
    if (value === 'safety' && !safetyAvailable) {
      return (
        <>
          {t('settings.sessions.permissions.explain.safetyUnavailable')}
          {' '}
          <SettingsInlineLink onClick={openClassificationProviders}>{t('settings.jevAccess.setUp')}</SettingsInlineLink>
        </>
      );
    }
    if (value === 'safety') {
      return (
        <>
          {providerName
            ? t('settings.sessions.permissions.explain.safetyVia', { provider: providerName })
            : t('settings.sessions.permissions.explain.safety')}
          {' '}
          <SettingsInlineLink onClick={openClassificationProviders}>{t('settings.jevAccess.manage')}</SettingsInlineLink>
        </>
      );
    }
    return (
      <>
        {value === 'auto' ? t('settings.sessions.permissions.explain.auto') : t('settings.sessions.permissions.explain.ask')}
        {' '}
        <SettingsInlineLink onClick={openAgentPermissions}>{t('settings.sessions.permissions.agentPermissionsLink')}</SettingsInlineLink>
      </>
    );
  };

  const chip = (value: PermissionMode, label: string) => {
    const { icon, color } = MODE_ICON[value];
    return {
      value,
      label: (
        <span className="inline-flex items-center gap-1.5">
          <Icon name={icon} className="size-3.5" style={color ? { color } : undefined} />
          {label}
        </span>
      ),
      tooltip: explanation(value),
      disabled: value === 'safety' && !safetyAvailable,
    };
  };

  return (
    <div className="space-y-1">
      <SettingsFieldRow
        settingsItem="sessions.permission-default"
        label={t('settings.sessions.permissions.defaultMode')}
        info={t('settings.sessions.permissions.defaultModeInfo')}
      >
        <SettingsChipGroup
          aria-label={t('settings.sessions.permissions.defaultMode')}
          value={shown}
          onChange={handleChange}
          options={[
            chip('ask', t('settings.sessions.permissions.mode.ask')),
            chip('safety', t('settings.sessions.permissions.mode.safety')),
            chip('auto', t('settings.sessions.permissions.mode.auto')),
          ]}
        />
      </SettingsFieldRow>
      {/* The chosen mode explains itself where touch users can read it too. */}
      <p className={SETTINGS_HELPER_CLASS}>{explanation(shown)}</p>
      {safetyAvailable ? null : <JevAccessNote />}
    </div>
  );
};
