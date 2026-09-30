import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { NumberInput } from '@/components/ui/number-input';
import { failureOfError, spaceFailureText } from '@/components/session/spaces/spaceFailureText';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import {
  SPACE_IDLE_STOP_MAX_HOURS,
  SPACE_IDLE_STOP_MIN_HOURS,
  readSpaceIdleStop,
  readSpacesSwitch,
  setSpaceIdleStop,
  setSpacesSwitch,
  type SpaceIdleStop,
  type SpacesSwitchChange,
} from '@/lib/spaces/spaces-api';
import { resetSpaceCreationRequests } from '@/lib/spaces/space-creation';
import { resetSpaceModelAccess } from '@/lib/spaces/space-model-access';
import { refreshSpacesJourney, spacesWithoutProject, useSpacesJourneyRead, useSpacesStore } from '@/lib/spaces/spaces-store';
import { SpaceRow } from '@/components/session/spaces/SpaceRow';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import {
  SETTINGS_ICON_BUTTON_CLASS,
  SETTINGS_NUMBER_INPUT_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
  SettingsCheckboxRow,
  SettingsControlGroup,
  SettingsFieldRow,
  SettingsInset,
  SettingsSection,
} from '../shared/SettingsSection';

const DEFAULT_IDLE_HOURS = 4;

/**
 * The idle stop (decision 11): a space stops itself after this many hours with no session working,
 * and keeps its files. The host keeps the setting and tells every running space at once; this row
 * shows what the host answered. Rendered only while the switch is on, because the route exists
 * only then (decision 19).
 */
const SpaceIdleStopSettings: React.FC = () => {
  const { t } = useI18n();
  const [setting, setSetting] = React.useState<SpaceIdleStop | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  // Only the answer to the latest change may set what the row shows.
  const latest = React.useRef(0);

  React.useEffect(() => {
    const controller = new AbortController();
    readSpaceIdleStop(controller.signal).then(setSetting, () => {
      if (!controller.signal.aborted) setLoadFailed(true);
    });
    return () => controller.abort();
  }, []);

  const change = async (next: SpaceIdleStop) => {
    const previous = setting;
    const turn = latest.current + 1;
    latest.current = turn;
    setSetting(next);
    reportSettingsSaveState('saving');
    try {
      const kept = await setSpaceIdleStop(next);
      if (turn === latest.current) setSetting(kept);
      reportSettingsSaveState('saved');
    } catch (failure) {
      if (!(failure instanceof Error)) throw failure;
      if (turn === latest.current) setSetting(previous);
      reportSettingsSaveState('error');
    }
  };

  if (loadFailed) {
    return <p className="pl-6 typography-ui-label text-[var(--status-error)]">{t('settings.openchamber.spaces.idleStop.loadFailed')}</p>;
  }
  if (!setting) return null;

  return (
    <>
      <SettingsCheckboxRow
        settingsItem="general.isolated-spaces-idle-stop"
        checked={setting.enabled}
        onChange={(enabled) => void change({ ...setting, enabled })}
        label={t('settings.openchamber.spaces.idleStop.enabled')}
        ariaLabel={t('settings.openchamber.spaces.idleStop.enabledAria')}
        info={t('settings.openchamber.spaces.idleStop.enabledInfo')}
      />
      {setting.enabled ? (
        <SettingsInset className="space-y-0">
          <SettingsFieldRow label={t('settings.openchamber.spaces.idleStop.after')}>
            <NumberInput
              value={setting.hours}
              onValueChange={(hours) => void change({ ...setting, hours })}
              min={SPACE_IDLE_STOP_MIN_HOURS}
              max={SPACE_IDLE_STOP_MAX_HOURS}
              step={1}
              // Typing "12" must not save 1 on the way and send it to every running space.
              deferExternalValueWhileFocused
              aria-label={t('settings.openchamber.spaces.idleStop.afterAria')}
              className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')}
            />
            <span className="typography-ui-label text-muted-foreground">{t('settings.openchamber.spaces.idleStop.hours')}</span>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => void change({ ...setting, hours: DEFAULT_IDLE_HOURS })}
              disabled={setting.hours === DEFAULT_IDLE_HOURS}
              className={SETTINGS_ICON_BUTTON_CLASS}
              aria-label={t('settings.openchamber.spaces.idleStop.resetAria')}
              title={t('settings.common.actions.reset')}
            >
              <Icon name="restart" className="h-3.5 w-3.5" />
            </Button>
          </SettingsFieldRow>
        </SettingsInset>
      ) : null}
    </>
  );
};

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
/**
 * The spaces whose project is no longer registered here (DESIGN.md, user journey step 9, and
 * decision 12): removed from OpenChamber or added again under another path, so no project menu
 * leads to them. Listed only when there are any, with the folder each was made for and the same
 * actions as a space's group. A read that fails lists nothing here rather than saying there are
 * none: this list is a way out, not the spaces' status.
 */
const SpacesWithoutProject: React.FC = () => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const { journey } = useSpacesJourneyRead();
  const spaces = journey ? spacesWithoutProject(journey) : [];
  if (spaces.length === 0) return null;
  return (
    <SettingsControlGroup title={t('settings.openchamber.spaces.withoutProject.title')} className="pt-2">
      <div className="space-y-1">
        {spaces.map((entry) => <SpaceRow key={entry.id} entry={entry} actions={isMobile ? 'sheet' : 'menu'} showFolder />)}
      </div>
    </SettingsControlGroup>
  );
};

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
      else {
        useSpacesStore.getState().forgetForSwitchOff();
        resetSpaceModelAccess();
        resetSpaceCreationRequests();
      }
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
        {enabled ? <SpaceIdleStopSettings /> : null}
      </div>
      {enabled ? <SpacesWithoutProject /> : null}
    </SettingsSection>
  );
};
