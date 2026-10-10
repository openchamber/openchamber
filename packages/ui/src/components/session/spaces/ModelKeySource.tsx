/**
 * Where a model's access comes from, as the create dialog and the grant dialog both ask it: the
 * host's own browser login, offered only when the host has one the space can be given (7c), an
 * environment variable of the host's, remembered by name and given again after every restart, or a
 * key typed once and kept nowhere. A provider that issues no key, GitHub Copilot, offers the login
 * alone (7d); a login whose token has no end says so, since the space keeps it until it is deleted.
 */

import React from 'react';

import { Input } from '@/components/ui/input';
import { Radio } from '@/components/ui/radio';
import { useI18n } from '@/lib/i18n';
import type { HostLoginOffer, KeySourceChoice, SpaceModelProviderOption } from './spaceModelKeys';

export const ModelKeySource: React.FC<{ provider: SpaceModelProviderOption; login: HostLoginOffer | null; choice: KeySourceChoice; onChange: (change: Partial<KeySourceChoice>) => void }> = ({ provider, login, choice, onChange }) => {
  const { t } = useI18n();
  const option = (checked: boolean, onSelect: () => void, label: string) => (
    <label className="flex cursor-pointer items-start gap-2">
      <Radio checked={checked} onChange={onSelect} ariaLabel={label} className="mt-0.5" />
      <span className="typography-ui-label text-foreground">{label}</span>
    </label>
  );
  return (
    <div className="space-y-1.5">
      {login ? option(choice.source === 'login', () => onChange({ source: 'login' }), t('spaces.create.access.login', { name: login.name })) : null}
      {login && login.expires === null ? <p className="pl-6 typography-meta text-status-warning">{t('spaces.create.access.loginNoEnd')}</p> : null}
      {provider.key ? (
        <>
          {option(choice.source === 'env', () => onChange({ source: 'env' }), t('spaces.create.access.fromEnv'))}
          {choice.source === 'env' ? (
            <div className="pl-6">
              <Input value={choice.envName} onChange={(event) => onChange({ envName: event.target.value })} className="h-9 max-w-sm font-mono" aria-label={t('spaces.create.access.envNameAria', { provider: provider.name })} />
              <p className="mt-1 typography-meta text-muted-foreground">{t('spaces.create.access.envComesBack')}</p>
            </div>
          ) : null}
          {option(choice.source === 'typed', () => onChange({ source: 'typed' }), t('spaces.create.access.typed'))}
          {choice.source === 'typed' ? (
            <div className="pl-6">
              <Input type="password" autoComplete="off" value={choice.value} onChange={(event) => onChange({ value: event.target.value })} className="h-9 max-w-sm" aria-label={t('spaces.create.access.keyAria', { provider: provider.name })} />
              <p className="mt-1 typography-meta text-status-warning">{t('spaces.create.access.typedNotKept')}</p>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
};
