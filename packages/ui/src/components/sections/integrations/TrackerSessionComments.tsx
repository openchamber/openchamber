import React from 'react';
import { Switch } from '@/components/ui/switch';
import {
  SettingsFieldRow,
  SETTINGS_FIELDS_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { reportSettingsSaveState } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';
import type { TrackerAPI, TrackerProviderId } from '@/lib/api/types';
import { trackerSettingsCopy } from './trackerSettingsCopy';

export function TrackerSessionComments({
  trackers,
  providerId,
  provider,
}: {
  trackers: TrackerAPI;
  providerId: TrackerProviderId;
  provider: string;
}) {
  const { t } = useI18n();
  const copy = trackerSettingsCopy(providerId).sessionComments;
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void trackers.preferencesGet(providerId)
      .then((preferences) => {
        if (cancelled) return;
        setEnabled(preferences.sessionComments);
        setLoadFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [providerId, trackers]);

  const save = React.useCallback(async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setIsSaving(true);
    try {
      const saved = await trackers.preferencesSet(providerId, { sessionComments: next });
      setEnabled(saved.sessionComments);
      reportSettingsSaveState('saved');
    } catch {
      setEnabled(previous);
      reportSettingsSaveState('error');
    } finally {
      setIsSaving(false);
    }
  }, [enabled, providerId, trackers]);

  if (loadFailed) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(copy.loadFailed, { provider })}
      </p>
    );
  }

  return (
    <div className={SETTINGS_FIELDS_STACK_CLASS}>
      <SettingsFieldRow
        label={t(copy.label)}
        info={t(copy.info)}
        settingsItem={`integrations.${providerId}.session-comments`}
      >
        <Switch
          checked={enabled === true}
          disabled={enabled === null || isSaving}
          onCheckedChange={(checked) => { void save(checked); }}
          aria-label={t(copy.aria, { provider })}
        />
      </SettingsFieldRow>
    </div>
  );
}
