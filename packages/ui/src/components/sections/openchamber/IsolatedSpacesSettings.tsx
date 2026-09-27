import React from 'react';

import { Button } from '@/components/ui/button';
import { failureOfError, spaceFailureText } from '@/components/session/spaces/spaceFailureText';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import { readSpacesSwitch, setSpacesSwitch, type SpacesSwitchChange } from '@/lib/spaces/spaces-api';
import { refreshSpacesJourney, useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { SETTINGS_OPTION_STACK_CLASS, SettingsCheckboxRow, SettingsSection } from '../shared/SettingsSection';

// What turning the switch off would do, asked of the host before it happens (decision 18): stop
// that many running spaces, or the list could not be read.
type TurnOffNotice = { kind: 'stops'; count: number } | { kind: 'unknown' };

/**
 * The switch of the isolated-spaces feature, live through the host's switch route: turning it on
 * makes the feature exist now, turning it off stops every running space and keeps its files. When
 * there is something to stop, or the host cannot say what runs, a notice says so before anything
 * happens, and a space that could not be stopped is named afterwards. Removing spaces is never
 * part of this. Never mounted in VS Code (decision 16), and nowhere until the feature is
 * released, see `lib/spaces/release.ts`.
 */
export const IsolatedSpacesSettings: React.FC = () => {
  const { t } = useI18n();
  const enabled = useUIStore((state) => state.isolatedSpacesEnabled);
  const setEnabled = useUIStore((state) => state.setIsolatedSpacesEnabled);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<TurnOffNotice | null>(null);
  const [outcome, setOutcome] = React.useState<SpacesSwitchChange | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // The host holds the switch; the setting this window remembers can be older than it.
  React.useEffect(() => {
    const controller = new AbortController();
    readSpacesSwitch(controller.signal).then((state) => setEnabled(state.enabled), () => undefined);
    return () => controller.abort();
  }, [setEnabled]);

  const change = async (next: boolean) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    reportSettingsSaveState('saving');
    try {
      const answer = await setSpacesSwitch(next);
      setEnabled(answer.enabled);
      setOutcome(answer.stillRunning.length > 0 ? answer : null);
      reportSettingsSaveState('saved');
      if (answer.enabled) void refreshSpacesJourney().catch(() => undefined);
      else useSpacesStore.getState().forgetForSwitchOff();
    } catch (failure) {
      reportSettingsSaveState('error');
      if (!(failure instanceof Error)) throw failure;
      setError(t('settings.openchamber.spaces.switchFailed', { reason: spaceFailureText(t, failureOfError(failure)) }));
    } finally {
      setBusy(false);
    }
  };

  const handleChange = async (next: boolean) => {
    setOutcome(null);
    if (next) {
      await change(true);
      return;
    }
    setBusy(true);
    const state = await readSpacesSwitch().catch(() => null);
    setBusy(false);
    if (!state || (state.enabled && state.spaces === null)) {
      setNotice({ kind: 'unknown' });
      return;
    }
    const running = state.enabled && state.spaces ? state.spaces.filter((space) => space.state === 'running').length : 0;
    if (running > 0) setNotice({ kind: 'stops', count: running });
    else await change(false);
  };

  const noticeText = notice?.kind === 'unknown'
    ? t('settings.openchamber.spaces.turnOff.unknown')
    : notice?.count === 1
      ? t('settings.openchamber.spaces.turnOff.stopsSingle')
      : t('settings.openchamber.spaces.turnOff.stopsPlural', { count: notice?.count ?? 0 });

  return (
    <SettingsSection title={t('settings.openchamber.spaces.title')}>
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsCheckboxRow
          settingsItem="general.isolated-spaces"
          checked={enabled}
          disabled={busy || notice !== null}
          onChange={(next) => void handleChange(next)}
          label={t('settings.openchamber.spaces.field.enabled')}
          ariaLabel={t('settings.openchamber.spaces.field.enabledAria')}
          info={t('settings.openchamber.spaces.field.enabledInfo')}
        />
        {notice ? (
          <div className="space-y-2 pl-6" role="alert">
            <p className="typography-ui-label text-[var(--status-warning)]">{noticeText}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={busy} onClick={() => setNotice(null)}>{t('settings.openchamber.spaces.turnOff.cancel')}</Button>
              <Button size="sm" disabled={busy} onClick={() => void change(false)}>{t('settings.openchamber.spaces.turnOff.confirm')}</Button>
            </div>
          </div>
        ) : null}
        {outcome?.stillRunning.map((space) => (
          <p key={space.id} className="pl-6 typography-ui-label text-[var(--status-warning)]">
            {t('settings.openchamber.spaces.turnOff.stillRunning', { name: space.name, reason: spaceFailureText(t, space) })}
          </p>
        ))}
        {error ? <p className="pl-6 typography-ui-label text-[var(--status-error)]">{error}</p> : null}
      </div>
    </SettingsSection>
  );
};
