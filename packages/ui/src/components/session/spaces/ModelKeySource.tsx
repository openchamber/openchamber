/**
 * Where a model key comes from, as the create dialog and the grant dialog both ask it: an
 * environment variable of the host's, remembered by name and given again after every restart, or a
 * key typed once and kept nowhere.
 */

import React from 'react';

import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { useI18n } from '@/lib/i18n';
import type { KeySourceChoice } from './spaceModelKeys';

export const ModelKeySource: React.FC<{ providerName: string; choice: KeySourceChoice; onChange: (change: Partial<KeySourceChoice>) => void }> = ({ providerName, choice, onChange }) => {
  const { t } = useI18n();
  const option = (checked: boolean, onSelect: () => void, label: string) => (
    <label className="flex cursor-pointer items-start gap-2">
      <Radio checked={checked} onChange={onSelect} ariaLabel={label} className="mt-0.5" />
      <span className="typography-ui-label text-foreground">{label}</span>
    </label>
  );
  return (
    <div className="space-y-1.5">
      {option(choice.source === 'env', () => onChange({ source: 'env' }), t('spaces.create.access.fromEnv'))}
      {choice.source === 'env' ? (
        <div className="pl-6">
          <Input value={choice.envName} onChange={(event) => onChange({ envName: event.target.value })} className="h-9 max-w-sm font-mono" aria-label={t('spaces.create.access.envNameAria', { provider: providerName })} />
          <p className="mt-1 typography-meta text-muted-foreground">{t('spaces.create.access.envComesBack')}</p>
        </div>
      ) : null}
      {option(choice.source === 'typed', () => onChange({ source: 'typed' }), t('spaces.create.access.typed'))}
      {choice.source === 'typed' ? (
        <div className="pl-6">
          <Input type="password" autoComplete="off" value={choice.value} onChange={(event) => onChange({ value: event.target.value })} className="h-9 max-w-sm" aria-label={t('spaces.create.access.keyAria', { provider: providerName })} />
          <p className="mt-1 typography-meta text-status-warning">{t('spaces.create.access.typedNotKept')}</p>
        </div>
      ) : null}
    </div>
  );
};
