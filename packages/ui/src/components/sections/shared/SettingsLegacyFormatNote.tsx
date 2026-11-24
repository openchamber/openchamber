import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';

interface SettingsLegacyFormatNoteProps {
  legacy: boolean;
  path?: string | null;
  className?: string;
}

export const SettingsLegacyFormatNote: React.FC<SettingsLegacyFormatNoteProps> = ({ legacy, path, className }) => {
  const { t } = useI18n();
  if (!legacy) return null;

  return (
    <p
      className={cn('mb-4 flex items-start gap-1.5', SETTINGS_HELPER_CLASS, className)}
      title={path ?? undefined}
    >
      <Icon name="information" className="mt-[0.2em] h-3.5 w-3.5 shrink-0 opacity-70" />
      <span>{t('settings.common.legacyFormat.note')}</span>
    </p>
  );
};
