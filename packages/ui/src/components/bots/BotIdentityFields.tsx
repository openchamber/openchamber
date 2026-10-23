import React from 'react';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { fetchBotIdentities } from '@/lib/botsApi';
import type { BotDefinition } from '@/lib/bots/config';
import { useI18n } from '@/lib/i18n';
import { BotSelectField } from './BotFields';
import { useBotResource } from './useBotRequest';
import { useBotGitHubAccounts } from './useBotGitHubAccounts';

export function BotIdentityFields({ projectId, value, onChange, onManage }: {
  readonly projectId: string; readonly value: BotDefinition['identity'];
  readonly onChange: (identity: BotDefinition['identity']) => void; readonly onManage: () => void;
}) {
  const { t } = useI18n();
  const load = React.useCallback(() => fetchBotIdentities(projectId), [projectId]);
  const identities = useBotResource(load);
  const github = useBotGitHubAccounts();
  const none = { value: '', label: t('bots.none') };
  const githubValue = value.github?.kind === 'account' ? `account:${value.github.accountId}` : value.github ? `app:${value.github.identityId}` : '';
  const githubOptions = [none,
    ...github.accounts.map((account) => ({ value: `account:${account.credentialId}`, label: `${account.user.username} · ${account.source}` })),
    ...(identities.data?.identities.filter((entry) => entry.kind === 'github-app').map((entry) => ({ value: `app:${entry.id}`, label: entry.label })) ?? []),
  ];
  if (githubValue && !githubOptions.some((entry) => entry.value === githubValue)) githubOptions.push({ value: githubValue, label: `${t('common.unavailable')} · ${githubValue}` });
  const serviceOptions = (service: 'jira' | 'discord', current: string) => {
    const options = [none, ...(identities.data?.identities.filter((entry) => entry.kind.startsWith(`${service}-`)).map((entry) => ({ value: entry.id, label: entry.label })) ?? [])];
    if (current && !options.some((entry) => entry.value === current)) options.push({ value: current, label: `${t('common.unavailable')} · ${current}` });
    return options;
  };
  return <SettingsSection title={t('bots.identities')} contentClassName="space-y-3" headerAction={<Button size="sm" variant="outline" onClick={onManage}>{t('bots.identities')}</Button>}>
    <BotSelectField label="GitHub" value={githubValue} options={githubOptions} onChange={(selected) => {
      const account = github.accounts.find((entry) => selected === `account:${entry.credentialId}`);
      const app = identities.data?.identities.find((entry) => entry.kind === 'github-app' && selected === `app:${entry.id}`);
      onChange({ ...value, github: account ? { kind: 'account', accountId: account.credentialId } : app ? { kind: 'app', identityId: app.id } : undefined });
    }} />
    <BotSelectField label="Jira" value={value.jira?.identityId ?? ''} options={serviceOptions('jira', value.jira?.identityId ?? '')} onChange={(identityId) => onChange({ ...value, jira: identityId ? { identityId } : undefined })} />
    <BotSelectField label="Discord" value={value.discord?.identityId ?? ''} options={serviceOptions('discord', value.discord?.identityId ?? '')} onChange={(identityId) => onChange({ ...value, discord: identityId ? { identityId } : undefined })} />
    {identities.error || github.error ? <p role="alert" className="typography-meta text-[var(--status-error-text)]">{t('bots.error')}</p> : null}
    {identities.busy || github.busy ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
  </SettingsSection>;
}
