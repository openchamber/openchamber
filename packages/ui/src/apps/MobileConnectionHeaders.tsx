import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

import { type MobileHeaderDraft } from './mobileRequestHeaders';
import { mobileConnectionInputClass, mobileInputKeyboardProps } from './mobileConnectionUi';

export const MobileConnectionHeaders: React.FC<{
  value: MobileHeaderDraft[];
  onChange: (value: MobileHeaderDraft[]) => void;
  disabled?: boolean;
}> = ({ value, onChange, disabled }) => {
  const { t } = useI18n();
  return (
    <fieldset className="min-w-0 space-y-2" disabled={disabled}>
      <legend className="px-1 typography-ui-label text-foreground">{t('settings.remoteInstances.direct.headers.title')}</legend>
      <p className="px-1 typography-micro text-muted-foreground">{t('mobile.connect.headers.hint')}</p>
      {value.map((header) => (
        <div key={header.id} className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-2">
            <input
              {...mobileInputKeyboardProps}
              dir="ltr"
              autoCapitalize="none"
              className={mobileConnectionInputClass}
              value={header.name}
              onChange={(event) => onChange(value.map((item) => item.id === header.id ? { ...item, name: event.target.value } : item))}
              placeholder={t('settings.remoteInstances.direct.headers.field.namePlaceholder')}
              aria-label={t('settings.remoteInstances.direct.headers.field.namePlaceholder')}
              pattern="[!#$%&'*+.^_`\|~0-9A-Za-z\-]+"
              required={Boolean(header.value)}
            />
            <input
              {...mobileInputKeyboardProps}
              dir="ltr"
              autoCapitalize="none"
              className={mobileConnectionInputClass}
              type="password"
              pattern="[\x20-\x7E\xA0-\xFF]*"
              value={header.value}
              onChange={(event) => onChange(value.map((item) => item.id === header.id ? { ...item, value: event.target.value } : item))}
              placeholder={t('settings.remoteInstances.direct.headers.field.valuePlaceholder')}
              aria-label={t('settings.remoteInstances.direct.headers.field.valuePlaceholder')}
              required={Boolean(header.name)}
            />
          </div>
          <Button type="button" variant="ghost" size="lg" className="min-h-11" onClick={() => onChange(value.filter((item) => item.id !== header.id))} aria-label={t('settings.remoteInstances.direct.headers.removeAria')}>
            <Icon name="close" className="size-5" />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="lg" className="min-h-11" onClick={() => onChange([...value, { id: crypto.randomUUID(), name: '', value: '' }])}>
        <Icon name="add" className="size-5" />
        {t('settings.remoteInstances.direct.headers.actions.add')}
      </Button>
    </fieldset>
  );
};
