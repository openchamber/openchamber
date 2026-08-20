import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import type { IconName } from '@/components/icon/icons';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';

type ComingSoonMessenger = {
  id: 'discord' | 'telegram';
  icon: IconName;
  brandClassName: string;
  nameKey: I18nKey;
  descriptionKey: I18nKey;
};

const COMING_SOON_MESSENGERS: readonly ComingSoonMessenger[] = [
  {
    id: 'discord',
    icon: 'discord-fill',
    brandClassName: 'text-[#5865F2]',
    nameKey: 'settings.integrations.messengers.discord.name',
    descriptionKey: 'settings.integrations.messengers.discord.description',
  },
  {
    id: 'telegram',
    icon: 'telegram-fill',
    brandClassName: 'text-[#2AABEE]',
    nameKey: 'settings.integrations.messengers.telegram.name',
    descriptionKey: 'settings.integrations.messengers.telegram.description',
  },
] as const;

/**
 * Non-interactive Discord/Telegram placeholders — same card chrome as live
 * integrations, greyed out, with a Coming soon badge and no expandable body.
 */
export const ComingSoonMessengersSection: React.FC = () => {
  const { t } = useI18n();

  return (
    <SettingsSection
      title={t('settings.integrations.messengers.title')}
      info={t('settings.integrations.messengers.info')}
      divider={false}
      settingsItem="integrations.messengers"
      contentClassName="space-y-3"
    >
      {COMING_SOON_MESSENGERS.map((messenger) => (
        <div
          key={messenger.id}
          data-settings-item={`integrations.messengers.${messenger.id}`}
          aria-disabled="true"
          className={cn(
            'flex min-w-0 items-center gap-3 rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-4 py-3',
            'pointer-events-none opacity-60',
          )}
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
            <Icon name={messenger.icon} className={cn('size-5', messenger.brandClassName)} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">{t(messenger.nameKey)}</div>
            <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground">
              {t(messenger.descriptionKey)}
            </p>
          </div>
          <span className="max-w-36 shrink-0 truncate rounded-full bg-[var(--surface-muted)] px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {t('settings.common.state.comingSoon')}
          </span>
        </div>
      ))}
    </SettingsSection>
  );
};
