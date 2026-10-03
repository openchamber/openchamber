import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';

interface SettingsLegacyFormatNoteProps {
  /** The entity's file still uses OpenCode 1 spellings. */
  legacy: boolean;
  /** The file OpenChamber rewrites on the next save. */
  path?: string | null;
  className?: string;
}

/**
 * One quiet line telling the user their config file predates OpenCode 2.
 * OpenChamber never moves the file: the next save rewrites it in place, so the
 * note is informational and has no action.
 */
export const SettingsLegacyFormatNote: React.FC<SettingsLegacyFormatNoteProps> = ({ legacy, path, className }) => {
  const { t } = useI18n();
  if (!legacy) return null;

  return (
    <p
      className={cn('mb-4 flex items-start gap-1.5', SETTINGS_HELPER_CLASS, className)}
      // The file path is detail, not the message: hover shows it, the line stays one sentence.
      title={path ?? undefined}
    >
      <Icon name="information" className="mt-[0.2em] h-3.5 w-3.5 shrink-0 opacity-70" />
      <span>{t('settings.common.legacyFormat.note')}</span>
    </p>
  );
};
