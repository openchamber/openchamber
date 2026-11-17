import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/i18n';

type AddDeviceFallbackOptionProps = {
  transport: 'local' | 'lan' | 'relay';
  hasLanUrl: boolean;
  checked: boolean;
  onChange: (checked: boolean) => void;
};

export const AddDeviceFallbackOption = ({ transport, hasLanUrl, checked, onChange }: AddDeviceFallbackOptionProps) => {
  const { t } = useI18n();
  if (transport === 'local' || (transport === 'relay' && !hasLanUrl)) return null;
  const label = transport === 'lan'
    ? t('settings.remoteInstances.clientAuth.addDevice.fallback.relay')
    : t('settings.remoteInstances.clientAuth.addDevice.fallback.preferLocal');
  return (
    <>
      <label className="flex w-fit cursor-pointer items-center gap-2 pt-1">
        <Checkbox checked={checked} onChange={onChange} ariaLabel={label} />
        <span className="typography-meta text-muted-foreground">{label}</span>
      </label>
      {transport === 'lan' && !checked ? (
        <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.addDevice.noNotificationsHint')}</p>
      ) : null}
    </>
  );
};
