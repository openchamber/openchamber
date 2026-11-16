
import React from 'react';

import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import type { HostLoginOffer, KeySourceChoice, SpaceModelProviderOption } from './spaceModelKeys';

export const ModelKeySource: React.FC<{ provider: SpaceModelProviderOption; login: HostLoginOffer | null; choice: KeySourceChoice; onChange: (change: Partial<KeySourceChoice>) => void; machine?: string | null }> = ({ provider, login, choice, onChange, machine = null }) => {
  const { t } = useI18n();
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
  if (!provider.key) {
    return login ? (
      <div className="space-y-1">
        <p className="typography-meta text-muted-foreground">{t('spaces.create.access.loginOnly', { name: login.name })}</p>
        {loginNoEnd}
      </div>
    ) : null;
  }
  const labelOf = (source: KeySourceChoice['source']) => {
    if (source === 'login' && login) return t('spaces.create.access.login', { name: login.name });
    if (source === 'stored') return t('spaces.create.access.stored');
    return source === 'typed' ? t('spaces.create.access.typed') : t('spaces.create.access.fromEnv');
  };
  return (
    <div className="space-y-1.5">
      <Select<KeySourceChoice['source']> value={choice.source} onValueChange={(source) => onChange({ source })}>
        <SelectTrigger className="w-fit" aria-label={t('spaces.create.access.sourceAria', { provider: provider.name })}>
          <SelectValue>{labelOf(choice.source)}</SelectValue>
        </SelectTrigger>
        <SelectContent portalToBody>
          {login ? <SelectItem value="login">{labelOf('login')}</SelectItem> : null}
          {provider.storedKey ? <SelectItem value="stored">{labelOf('stored')}</SelectItem> : null}
          <SelectItem value="env">{labelOf('env')}</SelectItem>
          <SelectItem value="typed">{labelOf('typed')}</SelectItem>
        </SelectContent>
      </Select>
      {choice.source === 'env' ? (
        <Input value={choice.envName} onChange={(event) => onChange({ envName: event.target.value })} className="w-full font-mono" spellCheck={false} placeholder={t('spaces.create.access.envNamePlaceholder')} aria-label={t('spaces.create.access.envNameAria', { provider: provider.name })} />
      ) : choice.source === 'typed' ? (
        <Input type="password" autoComplete="off" value={choice.value} onChange={(event) => onChange({ value: event.target.value })} className="w-full" aria-label={t('spaces.create.access.keyAria', { provider: provider.name })} />
      ) : null}
      {choice.source === 'env' ? <p className="typography-meta text-muted-foreground">{t('spaces.create.access.envComesBack')}</p> : null}
      {choice.source === 'stored' ? <p className="typography-meta text-muted-foreground">{t('spaces.create.access.storedComesBack')}</p> : null}
      {choice.source === 'typed' ? <p className="typography-meta text-muted-foreground">{t('spaces.create.access.typedNotKept')}</p> : null}
      {loginNoEnd}
    </div>
  );
};
