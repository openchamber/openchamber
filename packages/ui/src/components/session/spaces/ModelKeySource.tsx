/**
 * Where a model's access comes from, as the create dialog and the grant dialog both ask it, in one
 * row: a picker of the source and, beside it, what that source needs. The host's own browser login
 * is offered only when the host has one the space can be given (7c); an environment variable of the
 * host's is remembered by name and given again after every restart; a key pasted once is kept
 * nowhere. A provider that issues no key, GitHub Copilot, has the login alone (7d); a login whose
 * token has no end says so, since the space keeps it until it is deleted.
 */

import React from 'react';

import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import type { HostLoginOffer, KeySourceChoice, SpaceModelProviderOption } from './spaceModelKeys';

export const ModelKeySource: React.FC<{ provider: SpaceModelProviderOption; login: HostLoginOffer | null; choice: KeySourceChoice; onChange: (change: Partial<KeySourceChoice>) => void; machine?: string | null }> = ({ provider, login, choice, onChange, machine = null }) => {
  const { t } = useI18n();
  // A provider of the user's own asks for nothing: the host gives the key it has, or none.
  if (provider.custom) {
    const { custom } = provider;
    return (
      <div className="space-y-1">
        {custom.blocked === 'unsupported' ? <p className="typography-meta text-status-warning">{t('spaces.create.access.customUnsupported')}</p> : null}
        {custom.blocked === null ? <p className="typography-meta text-muted-foreground">{t(custom.hasKey ? 'spaces.create.access.customHostKey' : 'spaces.create.access.customNoKey')}</p> : null}
        {custom.blocked === null && custom.loopback && machine ? <p className="typography-meta text-status-warning">{t('spaces.create.access.customLoopbackOnMachine', { machine })}</p> : null}
      </div>
    );
  }
  const loginNoEnd = login && login.expires === null && choice.source === 'login'
    ? <p className="typography-meta text-status-warning">{t('spaces.create.access.loginNoEnd')}</p>
    : null;
  // A provider that issues no key: its login is the only way, so there is nothing to pick.
  if (!provider.key) {
    return login ? (
      <div className="space-y-1">
        <p className="typography-meta text-muted-foreground">{t('spaces.create.access.loginOnly', { name: login.name })}</p>
        {loginNoEnd}
      </div>
    ) : null;
  }
  const labelOf = (source: KeySourceChoice['source']) => (source === 'login' && login
    ? t('spaces.create.access.login', { name: login.name })
    : source === 'typed' ? t('spaces.create.access.typed') : t('spaces.create.access.fromEnv'));
  return (
    <div className="space-y-1.5">
      <Select<KeySourceChoice['source']> value={choice.source} onValueChange={(source) => onChange({ source })}>
        <SelectTrigger className="w-fit" aria-label={t('spaces.create.access.sourceAria', { provider: provider.name })}>
          <SelectValue>{labelOf(choice.source)}</SelectValue>
        </SelectTrigger>
        {/* On the body: inside a dialog the list would stretch the dialog while it is open. */}
        <SelectContent portalToBody>
          {login ? <SelectItem value="login">{labelOf('login')}</SelectItem> : null}
          <SelectItem value="env">{labelOf('env')}</SelectItem>
          <SelectItem value="typed">{labelOf('typed')}</SelectItem>
        </SelectContent>
      </Select>
      {/* The field gets the whole row, so a variable name is read in full. */}
      {choice.source === 'env' ? (
        <Input value={choice.envName} onChange={(event) => onChange({ envName: event.target.value })} className="w-full font-mono" spellCheck={false} aria-label={t('spaces.create.access.envNameAria', { provider: provider.name })} />
      ) : choice.source === 'typed' ? (
        <Input type="password" autoComplete="off" value={choice.value} onChange={(event) => onChange({ value: event.target.value })} className="w-full" aria-label={t('spaces.create.access.keyAria', { provider: provider.name })} />
      ) : null}
      {choice.source === 'env' ? <p className="typography-meta text-muted-foreground">{t('spaces.create.access.envComesBack')}</p> : null}
      {choice.source === 'typed' ? <p className="typography-meta text-muted-foreground">{t('spaces.create.access.typedNotKept')}</p> : null}
      {loginNoEnd}
    </div>
  );
};
