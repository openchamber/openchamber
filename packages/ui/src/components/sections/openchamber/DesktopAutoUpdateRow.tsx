import React from 'react';
import { SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui';
import { useDesktopAutoUpdateSetting } from '@/hooks/useDesktopAutoUpdateSetting';
import { useI18n } from '@/lib/i18n';

export const DesktopAutoUpdateRow: React.FC<{
  enabled: boolean;
  onEnabled?: () => void;
}> = ({ enabled: active, onEnabled }) => {
  const { t } = useI18n();
  const { autoUpdate, update } = useDesktopAutoUpdateSetting(active);

  if (!active || autoUpdate === null) return null;

  const toggle = async (next: boolean) => {
    const saved = await update(next);
    if (!saved) {
      toast.error(t('settings.openchamber.about.toast.autoUpdateNotSaved'));
      return;
    }
    if (next) onEnabled?.();
  };

  return (
    <SettingsFieldRow
      label={t('settings.openchamber.about.field.autoUpdate')}
      description={t('settings.openchamber.about.field.autoUpdateDescription')}
      alignEnd={false}
      controlClassName="min-h-8 flex-wrap @xl:flex-initial"
    >
      <Switch
        checked={autoUpdate}
        onCheckedChange={(checked) => void toggle(checked)}
        aria-label={t('settings.openchamber.about.field.autoUpdate')}
      />
    </SettingsFieldRow>
  );
};
