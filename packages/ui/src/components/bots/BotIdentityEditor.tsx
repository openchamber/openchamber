import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { writeBotIdentity } from '@/lib/botsApi';
import type { BotIdentity, BotIdentityInput } from '@/lib/bots/management';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { BotSelectField } from './BotFields';
import { useBotGitHubAccounts } from './useBotGitHubAccounts';
import { useBotAction } from './useBotRequest';

const identityKinds = {
  'github-account': 'bots.githubAccount', 'github-app': 'bots.githubApp', 'jira-account': 'bots.jiraAccount',
  'jira-service': 'bots.jiraService', 'discord-app': 'bots.discordApp',
} satisfies Record<BotIdentity['kind'], I18nKey>;

export function BotIdentityEditor({ projectId, initial, onSaved, onClose }: {
  readonly projectId: string; readonly initial: BotIdentity | null; readonly onSaved: () => void; readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [kind, setKind] = React.useState<BotIdentity['kind']>(initial?.kind ?? 'jira-account');
  const [label, setLabel] = React.useState(initial?.label ?? '');
  const [accountId, setAccountId] = React.useState(initial?.accountId ?? '');
  const [appId, setAppId] = React.useState(initial?.appId ?? '');
  const [installationId, setInstallationId] = React.useState(initial?.installationId ?? '');
  const [applicationId, setApplicationId] = React.useState(initial?.applicationId ?? '');
  const [site, setSite] = React.useState(initial?.site ?? '');
  const [email, setEmail] = React.useState(initial?.email ?? '');
  const [secret, setSecret] = React.useState('');
  const github = useBotGitHubAccounts();
  const action = useBotAction();
  const selectedAccount = github.accounts.find((account) => account.credentialId === accountId);
  const submit = () => action.run(async () => {
    let input: BotIdentityInput;
    switch (kind) {
      case 'github-account':
        if (!selectedAccount) return;
        input = { kind, label, accountId: selectedAccount.credentialId, credentialRevision: selectedAccount.credentialRevision }; break;
      case 'github-app': input = { kind, label, appId, installationId, privateKey: secret }; break;
      case 'jira-account': case 'jira-service': input = { kind, label, site, email, apiToken: secret }; break;
      case 'discord-app': input = { kind, label, applicationId, botToken: secret }; break;
      default: { const exhaustive: never = kind; return exhaustive; }
    }
    try {
      await writeBotIdentity(projectId, input, initial ?? undefined);
      if (action.isActive()) onSaved();
    } finally { setSecret(''); }
  });
  return <form className="@container space-y-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <div className="flex items-center justify-between gap-3">
      <Button size="sm" variant="ghost" onClick={onClose} disabled={action.busy}>{t('bots.back')}</Button>
      <Button size="sm" type="submit" disabled={action.busy || !label.trim() || (kind === 'github-account' ? !selectedAccount : !secret.trim())}>{t('settings.common.actions.saveChanges')}</Button>
    </div>
    <p className="typography-meta text-[var(--status-warning-text)]">{t('bots.redacted')}</p>
    <div className="min-h-5 typography-meta text-[var(--status-error-text)]" role="alert">{action.error}</div>
    <SettingsSection title={t('bots.identities')} divider={false} contentClassName="space-y-4">
      <BotSelectField<BotIdentity['kind']> label={t('bots.identities')} value={kind} onChange={(value) => { setKind(value); setSecret(''); }} options={(['github-account', 'github-app', 'jira-account', 'jira-service', 'discord-app'] as const).map((value) => ({ value, label: t(identityKinds[value]) }))} disabled={initial !== null} />
      <SettingsStackedField label={t('bots.name')}><Input required aria-label={t('bots.name')} value={label} onChange={(event) => setLabel(event.target.value)} /></SettingsStackedField>
      {kind === 'github-account' ? <>
        <BotSelectField label={t('bots.githubAccount')} value={accountId} onChange={setAccountId} options={[{ value: '', label: t('bots.none') }, ...github.accounts.map((account) => ({ value: account.credentialId, label: `${account.user.username} · ${account.source}` }))]} />
        {selectedAccount ? <p className="typography-meta" dir="ltr">{selectedAccount.credentialId} · {selectedAccount.credentialRevision}</p> : null}
      </> : null}
      {kind === 'github-app' ? <>
        <SettingsStackedField label={t('bots.appId')}><Input required dir="ltr" aria-label={t('bots.appId')} value={appId} onChange={(event) => setAppId(event.target.value)} /></SettingsStackedField>
        <SettingsStackedField label={t('bots.installationId')}><Input required dir="ltr" aria-label={t('bots.installationId')} value={installationId} onChange={(event) => setInstallationId(event.target.value)} /></SettingsStackedField>
      </> : null}
      {kind === 'jira-account' || kind === 'jira-service' ? <>
        <SettingsStackedField label={t('bots.site')}><Input required type="url" dir="ltr" aria-label={t('bots.site')} value={site} onChange={(event) => setSite(event.target.value)} /></SettingsStackedField>
        <SettingsStackedField label={t('bots.email')}><Input required type="email" dir="ltr" aria-label={t('bots.email')} value={email} onChange={(event) => setEmail(event.target.value)} /></SettingsStackedField>
      </> : null}
      {kind === 'discord-app' ? <SettingsStackedField label={t('bots.applicationId')}><Input required dir="ltr" aria-label={t('bots.applicationId')} value={applicationId} onChange={(event) => setApplicationId(event.target.value)} /></SettingsStackedField> : null}
      {kind !== 'github-account' ? <SettingsStackedField label={t('bots.secret')} controlClassName={kind === 'github-app' ? 'max-w-none w-full' : undefined}>
        {kind === 'github-app' ? <Textarea required dir="ltr" aria-label={t('bots.secret')} autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} /> : <Input required dir="ltr" type="password" autoComplete="new-password" aria-label={t('bots.secret')} value={secret} onChange={(event) => setSecret(event.target.value)} />}
      </SettingsStackedField> : null}
    </SettingsSection>
  </form>;
}
