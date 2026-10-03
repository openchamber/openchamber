import React from 'react';
import { Switch } from '@/components/ui/switch';
import {
  SettingsFieldRow,
  SETTINGS_FIELDS_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { reportSettingsSaveState } from '@/lib/persistence';
import { useI18n } from '@/lib/i18n';
import type { LinearAPI } from '@/lib/api/types';

/**
 * Status comments are written into a Linear workspace other people read, so
 * they stay off until the user turns them on. The server posts nothing while
 * this is off, including the completed and failure comments the event hub
 * sends without going through this interface.
 */
export function LinearSessionComments({
  linear,
  connected,
}: {
  linear: LinearAPI;
  connected: boolean;
}) {
  const { t } = useI18n();
  const [enabled, setEnabled] = React.useState<boolean | null>(null);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);

  React.useEffect(() => {
    if (!connected) {
      setEnabled(null);
      setLoadFailed(false);
      return;
    }
    let cancelled = false;
    void linear.preferencesGet()
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
  }, [connected, linear]);

  const save = React.useCallback(async (next: boolean) => {
    const previous = enabled;
    setEnabled(next);
    setIsSaving(true);
    try {
      const saved = await linear.preferencesSet({ sessionComments: next });
      setEnabled(saved.sessionComments);
      reportSettingsSaveState('saved');
    } catch {
      setEnabled(previous);
      reportSettingsSaveState('error');
    } finally {
      setIsSaving(false);
    }
  }, [enabled, linear]);

  if (!connected) {
    return null;
  }

  if (loadFailed) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('settings.integrations.linear.sessionComments.loadFailed')}
      </p>
    );
  }

  return (
    <div className={SETTINGS_FIELDS_STACK_CLASS}>
      <SettingsFieldRow
        label={t('settings.integrations.linear.sessionComments.label')}
        info={t('settings.integrations.linear.sessionComments.info')}
        settingsItem="integrations.linear.session-comments"
      >
        <Switch
          checked={enabled === true}
          disabled={enabled === null || isSaving}
          onCheckedChange={(checked) => { void save(checked); }}
          aria-label={t('settings.integrations.linear.sessionComments.aria')}
        />
      </SettingsFieldRow>
    </div>
  );
}
