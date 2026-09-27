import React from 'react';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  SettingsSection,
  SettingsCheckboxRow,
  SETTINGS_OPTION_STACK_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import {
  DEFAULT_SOUND_BY_CHANNEL,
  SOUND_CHANNELS,
  SOUND_PACKS,
  isSoundId,
  previewSoundById,
  soundIdsForPack,
  type SoundChannel,
  type SoundId,
  type SoundPack,
} from '@/lib/notificationSound';

const SOUND_CHANNEL_LABEL_KEYS = {
  completion: 'settings.notifications.page.sounds.channel.completion',
  question: 'settings.notifications.page.sounds.channel.question',
  permission: 'settings.notifications.page.sounds.channel.permission',
  error: 'settings.notifications.page.sounds.channel.error',
} as const satisfies Record<SoundChannel, string>;

/** `yup-03` reads as `Yup · 03`: the pack groups the list, the number orders it. */
const soundOptionLabel = (id: string): string => {
  const [pack, index] = id.split('-');
  return `${pack} · ${index}`;
};

const packLabel = (pack: SoundPack): string => `${pack[0].toUpperCase()}${pack.slice(1)}`;

const SOUND_SETTING_BY_CHANNEL = {
  completion: 'notificationSoundCompletion',
  question: 'notificationSoundQuestion',
  permission: 'notificationSoundPermission',
  error: 'notificationSoundError',
} as const satisfies Record<SoundChannel, keyof ReturnType<typeof useUIStore.getState>>;

const SETTER_BY_CHANNEL = {
  completion: 'setNotificationSoundCompletion',
  question: 'setNotificationSoundQuestion',
  permission: 'setNotificationSoundPermission',
  error: 'setNotificationSoundError',
} as const satisfies Record<SoundChannel, keyof ReturnType<typeof useUIStore.getState>>;

const CHANNELS = SOUND_CHANNELS;

export const NotificationSoundSettings: React.FC = () => {
  const { t } = useI18n();
  const soundsEnabled = useUIStore(state => state.notificationSoundsEnabled);
  const setSoundsEnabled = useUIStore(state => state.setNotificationSoundsEnabled);
  const soundWhen = useUIStore(state => state.notificationSoundWhen);
  const setSoundWhen = useUIStore(state => state.setNotificationSoundWhen);
  const [playbackBlocked, setPlaybackBlocked] = React.useState(false);

  const handlePreview = React.useCallback(async (id: SoundId) => {
    setPlaybackBlocked(!(await previewSoundById(id)));
  }, []);

  return (
    <SettingsSection
      settingsItem="notifications.sounds"
      title={t('settings.notifications.page.sounds.title')}
    >
      <div className={SETTINGS_OPTION_STACK_CLASS}>
        <SettingsCheckboxRow
          checked={soundsEnabled}
          onChange={setSoundsEnabled}
          label={t('settings.notifications.page.sounds.enableLabel')}
          description={t('settings.notifications.page.sounds.hint')}
          ariaLabel={t('settings.notifications.page.sounds.enableAria')}
        />

        {soundsEnabled && (
          <>
            <div className="flex items-center justify-between gap-3">
              <span className="typography-meta text-muted-foreground">
                {t('settings.notifications.page.sounds.when.label')}
              </span>
              <Select
                value={soundWhen}
                onValueChange={(value) => {
                  if (value !== 'always' && value !== 'hidden-only') return;
                  setSoundWhen(value);
                }}
              >
                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hidden-only">
                    {t('settings.notifications.page.sounds.when.hiddenOnly')}
                  </SelectItem>
                  <SelectItem value="always">
                    {t('settings.notifications.page.sounds.when.always')}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>

            {CHANNELS.map((channel) => (
              <SoundChannelRow
                key={channel}
                channel={channel}
                label={t(SOUND_CHANNEL_LABEL_KEYS[channel])}
                previewLabel={t('settings.notifications.page.sounds.previewLabel')}
                onPreview={handlePreview}
              />
            ))}

            {playbackBlocked && (
              <p className="typography-meta text-muted-foreground/70">
                {t('settings.notifications.page.sounds.blockedHint')}
              </p>
            )}
          </>
        )}
      </div>
    </SettingsSection>
  );
};

type SoundChannelRowProps = {
  channel: SoundChannel;
  label: string;
  previewLabel: string;
  onPreview: (id: SoundId) => void | Promise<void>;
};

const SoundChannelRow: React.FC<SoundChannelRowProps> = ({
  channel,
  label,
  previewLabel,
  onPreview,
}) => {
  const { t } = useI18n();
  // SAFETY: both maps are `as const` over the four channels, so the indexed key
  // is a `string` field and a `(next: string) => void` setter on the store.
  const value = useUIStore(state => state[SOUND_SETTING_BY_CHANNEL[channel]] as string);
  // SAFETY: as above, for the matching setter key.
  const setValue = useUIStore(state => state[SETTER_BY_CHANNEL[channel]] as (next: string) => void);
  const selected: SoundId = isSoundId(value) ? value : DEFAULT_SOUND_BY_CHANNEL[channel];

  return (
    <div className="flex items-center justify-between gap-3">
      <span className="typography-meta text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <Select value={selected} onValueChange={(next) => setValue(next)}>
          <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SOUND_PACKS.map((pack) => (
              <SelectGroup key={pack}>
                <SelectLabel>{packLabel(pack)}</SelectLabel>
                {soundIdsForPack(pack).map((id) => (
                  <SelectItem key={id} value={id}>
                    {soundOptionLabel(id)}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 shrink-0"
          aria-label={`${label}: ${t('settings.notifications.page.sounds.previewAria')}`}
          onClick={() => void onPreview(selected)}
        >
          {previewLabel}
        </Button>
      </div>
    </div>
  );
};
