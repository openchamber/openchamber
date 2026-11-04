import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

export function Settings() {
  const { t } = useI18n();
  const selectionApprovalText = useUIStore((state) => state.selectionApprovalText);
  const setSelectionApprovalText = useUIStore((state) => state.setSelectionApprovalText);

  return (
    <SettingsStackedField
      className="pt-3"
      label={t('settings.openchamber.visual.field.selectionApprovalText')}
      info={t('settings.openchamber.visual.field.selectionApprovalTextInfo')}
      settingsItem="chat.selection-approval-text"
    >
      <Input
        value={selectionApprovalText}
        placeholder="LGTM"
        onChange={(event) => setSelectionApprovalText(event.target.value)}
        aria-label={t('settings.openchamber.visual.field.selectionApprovalText')}
        dir="auto"
      />
    </SettingsStackedField>
  );
}
