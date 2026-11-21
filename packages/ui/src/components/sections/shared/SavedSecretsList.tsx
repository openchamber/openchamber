import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SETTINGS_FIELD_LABEL_CLASS, SETTINGS_ICON_BUTTON_CLASS } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function SavedSecretsList({ names, disabled, onRemove }: { names: string[]; disabled: boolean; onRemove: (name: string) => void }) {
  const { t } = useI18n();
  if (names.length === 0) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.environment.secrets.label')}</span>
        <SettingsInfoHint>{t('settings.environment.secrets.info')}</SettingsInfoHint>
      </div>
      <ul className="w-full max-w-[32rem] space-y-1">
        {names.map((name) => (
          <li key={name} className="flex min-h-8 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-xs text-foreground">{name}</span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => onRemove(name)}
              disabled={disabled}
              className={cn('ms-auto', SETTINGS_ICON_BUTTON_CLASS)}
              aria-label={t('settings.environment.editor.removeAria', { name })}
              title={t('settings.environment.editor.remove')}
            >
              <Icon name="delete-bin" className="h-3.5 w-3.5" />
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
