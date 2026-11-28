import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsSection, SettingsFieldRow, SettingsChipGroup } from '@/components/sections/shared/SettingsSection';
import { canCopyImageToClipboard } from '@/components/chat/message/imageExportTarget';

const IMAGE_EXPORT_TARGET_OPTIONS = [
  { value: 'file', labelKey: 'settings.openchamber.visual.option.imageExportTarget.file.label' },
  { value: 'clipboard', labelKey: 'settings.openchamber.visual.option.imageExportTarget.clipboard.label' },
  { value: 'both', labelKey: 'settings.openchamber.visual.option.imageExportTarget.both.label' },
] as const;

export const ChatImageSettingsSection: React.FC = () => {
  const { t } = useI18n();
  const imageExportTarget = useUIStore((state) => state.imageExportTarget);
  const setImageExportTarget = useUIStore((state) => state.setImageExportTarget);
  const options = React.useMemo(
    () => IMAGE_EXPORT_TARGET_OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) })),
    [t],
  );

  if (!canCopyImageToClipboard()) return null;

  return (
    <SettingsSection title={t('settings.layout.chat.section.images')} contentClassName="space-y-3">
      <SettingsFieldRow
        label={t('settings.openchamber.visual.field.imageExportTarget')}
        info={t('settings.openchamber.visual.field.imageExportTargetInfo')}
        settingsItem="chat.image-export"
      >
        <SettingsChipGroup
          value={imageExportTarget}
          options={options}
          onChange={setImageExportTarget}
          aria-label={t('settings.openchamber.visual.field.imageExportTargetAria')}
        />
      </SettingsFieldRow>
    </SettingsSection>
  );
};
