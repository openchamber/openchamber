import { SettingsControlGroup, SettingsSection, SettingsStackedField, SettingsTwoColumn } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BotDefinition } from '@/lib/bots/config';
import { useI18n } from '@/lib/i18n';

export function BotDiscordFields({ value, onChange }: {
  readonly value: BotDefinition['discord'];
  readonly onChange: (discord: BotDefinition['discord']) => void;
}) {
  const { t } = useI18n();
  return <SettingsSection title={t('bots.discordChannels')} info={t('bots.discordChannelsHint')} contentClassName="space-y-4">
    {value.channels.map((channel, index) => <SettingsControlGroup key={index} title={t('bots.discordChannel', { number: index + 1 })} contentClassName="space-y-3">
      <SettingsTwoColumn>
        <SettingsStackedField label={t('bots.discordGuildId')}>
          <Input required dir="ltr" inputMode="numeric" pattern="[1-9][0-9]{5,24}" maxLength={25} aria-label={t('bots.discordGuildId')} value={channel.guildId}
            onChange={(event) => onChange({ channels: value.channels.map((entry, row) => row === index ? { ...entry, guildId: event.target.value } : entry) })} />
        </SettingsStackedField>
        <SettingsStackedField label={t('bots.discordChannelId')}>
          <Input required dir="ltr" inputMode="numeric" pattern="[1-9][0-9]{5,24}" maxLength={25} aria-label={t('bots.discordChannelId')} value={channel.channelId}
            onChange={(event) => onChange({ channels: value.channels.map((entry, row) => row === index ? { ...entry, channelId: event.target.value } : entry) })} />
        </SettingsStackedField>
      </SettingsTwoColumn>
      <Button variant="ghost" onClick={() => onChange({ channels: value.channels.filter((_, row) => row !== index) })}>{t('bots.discordRemoveChannel')}</Button>
    </SettingsControlGroup>)}
    <Button variant="outline" disabled={value.channels.length >= 100} onClick={() => onChange({ channels: [...value.channels, { guildId: '', channelId: '' }] })}>{t('bots.discordAddChannel')}</Button>
  </SettingsSection>;
}
