import React from 'react';
import { Button } from '@/components/ui/button';
import { deleteBotIdentity, fetchBotIdentities } from '@/lib/botsApi';
import type { BotIdentity } from '@/lib/bots/management';
import { useI18n } from '@/lib/i18n';
import { BotIdentityEditor } from './BotIdentityEditor';
import { useBotAction, useBotResource } from './useBotRequest';

export function BotIdentities({ projectId }: { readonly projectId: string }) {
  const { t } = useI18n();
  const load = React.useCallback(() => fetchBotIdentities(projectId), [projectId]);
  const read = useBotResource(load);
  const action = useBotAction();
  const [editor, setEditor] = React.useState<{ readonly identity: BotIdentity | null } | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);
  if (editor) return <BotIdentityEditor projectId={projectId} initial={editor.identity} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); read.refresh(); }} />;
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3">
      <Button size="sm" onClick={() => setEditor({ identity: null })}>{t('bots.addIdentity')}</Button>
      <Button size="sm" variant="outline" disabled={read.busy} onClick={read.refresh}>{t('bots.refresh')}</Button>
    </div>
    <p className="typography-meta text-muted-foreground">{t('bots.redacted')}</p>
    {read.error || action.error ? <p className="typography-meta text-[var(--status-error-text)]" role="alert">{action.error ?? t('bots.error')}</p> : null}
    {read.busy && !read.data ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {read.data?.identities.length === 0 ? <p className="typography-meta text-muted-foreground">{t('bots.empty')}</p> : null}
    {read.data?.identities.map((identity) => <article key={identity.id} className="oc-tile min-w-0 space-y-2 rounded-lg p-3">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <p className="truncate typography-ui-label" dir="auto" title={identity.label}>{identity.label}</p>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={action.busy} onClick={() => setEditor({ identity })}>{t('bots.edit')}</Button><Button size="sm" variant="ghost" disabled={action.busy} onClick={() => setRemoving(identity.id)}>{t('settings.common.actions.delete')}</Button></div>
      </div>
      <p className="typography-meta text-muted-foreground" dir="ltr">{identity.kind} · {identity.revision}</p>
      <p className="break-all typography-meta" dir="auto">{[identity.accountId, identity.site, identity.email, identity.appId, identity.installationId, identity.applicationId].filter(Boolean).join(' · ')}</p>
      {removing === identity.id ? <div className="space-y-2">
        <p className="typography-meta text-[var(--status-warning-text)]">{t('bots.removeIdentity')}</p>
        <div className="flex gap-2"><Button size="sm" variant="destructive" disabled={action.busy} onClick={() => void action.run(async () => {
          await deleteBotIdentity(projectId, identity);
          if (action.isActive()) { setRemoving(null); read.refresh(); }
        })}>{t('settings.common.actions.delete')}</Button><Button size="sm" variant="ghost" disabled={action.busy} onClick={() => setRemoving(null)}>{t('settings.common.actions.cancel')}</Button></div>
      </div> : null}
    </article>)}
  </div>;
}
