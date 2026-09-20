import * as React from 'react';

import {
  SettingsSection,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
} from '@/components/sections/shared/SettingsSection';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { BUILTIN_BROWSER_PROVIDER, browserProviderGuests } from '@/lib/guests/browser-providers';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import { useGuestsStore } from '@/lib/guests/store';
import { recordDeferredOpenCodeRestart } from '@/lib/opencode/deferredRestart';
import { updateDesktopSettings } from '@/lib/persistence';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
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
  const browserProvider = useUIStore((state) => state.browserProvider);
  const setBrowserProvider = useUIStore((state) => state.setBrowserProvider);
  const guests = useGuestsStore((state) => state.guests);
  const agentMemoryToolEnabled = useUIStore((state) => state.agentMemoryToolEnabled);
  // Absent, not merely off: the feature is finished but unreleased, and a
  // visible switch invites turning on something that was never announced.
  const agentMemoryAvailable = useUIStore((state) => state.agentMemoryFeatureAvailable);
  const setAgentMemoryToolEnabled = useUIStore((state) => state.setAgentMemoryToolEnabled);

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

  // The dropdown lists installed extensions, so the catalog has to be loaded
  // here too: this page can be the first thing opened after a fresh start.
  React.useEffect(() => {
    void loadGuestCatalog();
  }, []);
  const providerGuests = React.useMemo(() => browserProviderGuests(guests), [guests]);
  // A selection whose extension is gone shows as the built-in: the server
  // already routes to it and resets the setting on the next action.
  const providerValue = providerGuests.some((guest) => guest.id === browserProvider)
    ? browserProvider
    : BUILTIN_BROWSER_PROVIDER;

  // Read by the server on the next browser action; no OpenCode restart involved.
  const handleBrowserProviderChange = React.useCallback((value: string) => {
    setBrowserProvider(value);
    void updateDesktopSettings({ browserProvider: value });
  }, [setBrowserProvider]);

  // Turning memory off removes the whole feature, not just the tool: the panel
  // tab goes with it and sessions stop being given the index. Showing the user
  // what is stored would be pointless once the agent can no longer manage it.
  const handleAgentMemoryToolChange = React.useCallback((enabled: boolean) => {
    setAgentMemoryToolEnabled(enabled);
    // Re-read after the write lands, not before. The switch flips the client
    // immediately, which makes the panel ask the server straight away — and
    // while the setting is still being written the server truthfully answers
    // "disabled", which used to leave the tab hidden until a restart.
    void updateDesktopSettings({ agentMemoryToolEnabled: enabled })
      .finally(() => {
        if (enabled) {
          void useAgentMemoryStore.getState().refresh();
        }
      });
    recordDeferredOpenCodeRestart('cli', { id: 'agent-memory-tool' });
  }, [setAgentMemoryToolEnabled]);

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

        <SettingsFieldRow
          settingsItem="sessions.browser-provider"
          label={t('settings.openchamber.tools.browserProvider.label')}
          info={t('settings.openchamber.tools.browserProvider.info')}
        >
          <Select<string>
            value={providerValue}
            onValueChange={handleBrowserProviderChange}
            disabled={!agentWebToolEnabled || providerGuests.length === 0}
          >
            <SelectTrigger
              size={SETTINGS_SELECT_SIZE}
              className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}
              aria-label={t('settings.openchamber.tools.browserProvider.aria')}
            >
              <SelectValue>
                {(value) => (
                  value === BUILTIN_BROWSER_PROVIDER
                    ? t('settings.openchamber.tools.browserProvider.option.builtin')
                    : providerGuests.find((guest) => guest.id === value)?.name ?? null
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={BUILTIN_BROWSER_PROVIDER}>
                {t('settings.openchamber.tools.browserProvider.option.builtin')}
              </SelectItem>
              {providerGuests.map((guest) => (
                <SelectItem key={guest.id} value={guest.id}>{guest.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>

        {agentMemoryAvailable ? (
        <SettingsCheckboxRow
          settingsItem="sessions.agent-memory-tool"
          checked={agentMemoryToolEnabled}
          onChange={handleAgentMemoryToolChange}
          label={t('settings.openchamber.tools.field.agentMemoryTool')}
          ariaLabel={t('settings.openchamber.tools.field.agentMemoryToolAria')}
          info={t('settings.openchamber.tools.field.agentMemoryToolInfo')}
        />
        ) : null}
      </div>
    </SettingsSection>
  );
};
