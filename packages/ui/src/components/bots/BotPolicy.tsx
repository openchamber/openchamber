import React from 'react';
import { Button } from '@/components/ui/button';
import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { approveBotPolicy, fetchBotPolicy } from '@/lib/botsApi';
import { useI18n } from '@/lib/i18n';
import { useBotAction, useBotResource } from './useBotRequest';

export function BotPolicy({ projectId }: { readonly projectId: string }) {
  const { t } = useI18n();
  const load = React.useCallback(() => fetchBotPolicy(projectId), [projectId]);
  const read = useBotResource(load);
  const action = useBotAction();
  const [reviewed, setReviewed] = React.useState<ReadonlySet<string>>(new Set());
  const approve = (file: string, fingerprint: string) => action.run(async () => {
    await approveBotPolicy(projectId, { file, fingerprint });
    if (action.isActive()) read.refresh();
  });
  const reviewControls = (file: string, fingerprint: string, approved: boolean) => <div className="space-y-3">
    <p className="break-all font-mono typography-meta" dir="ltr">{fingerprint}</p>
    <SettingsCheckboxRow label={t('bots.reviewContent')} checked={reviewed.has(fingerprint)} disabled={approved || action.busy} onChange={(checked) => setReviewed((current) => {
      const next = new Set(current); if (checked) next.add(fingerprint); else next.delete(fingerprint); return next;
    })} />
    <Button size="sm" disabled={approved || action.busy || !reviewed.has(fingerprint)} onClick={() => void approve(file, fingerprint)}>{approved ? t('bots.approved') : t('bots.approve')}</Button>
  </div>;
  return <div className="@container space-y-4">
    <div className="flex justify-end"><Button variant="outline" size="sm" disabled={read.busy} onClick={read.refresh}>{t('bots.refresh')}</Button></div>
    <p className="typography-meta text-[var(--status-warning-text)]">{t('bots.humanWarning')}</p>
    <p className="break-words typography-meta" dir="ltr">.agents/areas/ · .openchamber/ · .github/ · CODEOWNERS</p>
    {read.error || action.error ? <p role="alert" className="typography-meta text-[var(--status-error-text)]">{action.error ?? t('bots.error')}</p> : null}
    {read.busy && !read.data ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {read.data?.issues.map((issue) => <p key={issue.file} role="alert" className="break-words typography-meta text-[var(--status-warning-text)]">{issue.file} · {issue.error}</p>)}
    {read.data?.areas.map((area, index) => <SettingsSection key={area.file} title={area.name} divider={index > 0} contentClassName="space-y-3 typography-meta">
      <p dir="ltr" className="break-all font-mono">{area.file}</p>
      <p>{area.status === 'approved' ? t('bots.approved') : area.status === 'changed' ? t('bots.changed') : t('bots.unapproved')} · {area.status !== 'approved' || area.level === 'human' ? t('bots.human') : t('bots.judge')}</p>
      <p dir="ltr" className="break-words">{area.paths.join('\n')}</p><p className="break-words">{area.owners.join(', ')}</p>
      <pre dir="auto" className="whitespace-pre-wrap break-words font-sans">{area.body}</pre>
      {reviewControls(area.file, area.fingerprint, area.status === 'approved')}
    </SettingsSection>)}
    {read.data ? <SettingsSection title=".openchamber/people.json" contentClassName="space-y-3 typography-meta">
      {read.data.people.content ? <pre dir="auto" className="whitespace-pre-wrap break-words">{read.data.people.content}</pre> : read.data.people.status === 'approved' ? <pre dir="auto" className="whitespace-pre-wrap break-words">{JSON.stringify(read.data.people.people, null, 2)}</pre> : <p className="text-[var(--status-warning-text)]">{t('bots.peopleMissing')}</p>}
      {read.data.people.fingerprint && (read.data.people.content || read.data.people.status === 'approved') ? reviewControls(read.data.people.file, read.data.people.fingerprint, read.data.people.status === 'approved') : null}
      {read.data.people.error ? <p className="break-words text-[var(--status-error-text)]">{read.data.people.error}</p> : null}
    </SettingsSection> : null}
  </div>;
}
