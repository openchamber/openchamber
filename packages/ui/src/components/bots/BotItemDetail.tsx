import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { actOnBotItem, fetchBotItem } from '@/lib/botsApi';
import type { BotItem } from '@/lib/bots/items';
import { isTerminalBotItem } from '@/lib/bots/items';
import { useI18n } from '@/lib/i18n';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { BotStateLabel } from './BotItemList';
import { BotEvidence, BotLink } from './BotEvidence';
import { useBotAction, useBotResource, useBotsRefresh } from './useBotRequest';

export function BotItemDetail({ projectId, initial, archived = false, onBack, onLeave }: {
  readonly projectId: string; readonly initial: BotItem; readonly archived?: boolean;
  readonly onBack: () => void; readonly onLeave: () => void;
}) {
  const { t, locale } = useI18n();
  const load = React.useCallback(() => fetchBotItem(projectId, initial.id), [projectId, initial.id]);
  const read = useBotResource(load);
  useBotsRefresh(projectId, read.refresh, !archived);
  const item = read.data?.item ?? initial;
  const action = useBotAction();
  const [answer, setAnswer] = React.useState('');
  const delivery = React.useRef<{ readonly text: string; readonly eventId: string } | null>(null);
  const operate = (kind: 'resume' | 'stop' | 'answer') => action.run(async () => {
    if (kind === 'answer') {
      if (!answer.trim()) return;
      if (delivery.current?.text !== answer) delivery.current = { text: answer, eventId: crypto.randomUUID() };
      await actOnBotItem(projectId, item.id, { kind, ...delivery.current });
      if (action.isActive()) { setAnswer(''); delivery.current = null; }
    } else await actOnBotItem(projectId, item.id, { kind });
    if (action.isActive()) read.refresh();
  });
  const openSession = (sessionId: string) => {
    const detail = read.data;
    if (!detail || !Object.hasOwn(detail.sessionDirectories, sessionId)) return;
    useSessionUIStore.getState().setCurrentSession(sessionId, detail.sessionDirectories[sessionId]);
    onLeave();
  };
  return <div className="min-w-0 @container">
    <div className="mb-4 flex min-w-0 items-center justify-between gap-2">
      <Button size="sm" variant="ghost" onClick={onBack}>{t('bots.back')}</Button>
      {!archived ? <Button size="sm" variant="outline" disabled={read.busy} onClick={read.refresh}>{t('bots.refresh')}</Button> : null}
    </div>
    <h2 className="break-words typography-ui-header" dir="auto">{item.title}</h2>
    <p className="my-2 typography-meta"><BotStateLabel state={item.state} /> · {t('bots.tokens', { count: item.tokens.total })}</p>
    {item.description ? <p className="mb-5 whitespace-pre-wrap break-words typography-ui-label" dir="auto">{item.description}</p> : null}
    {read.error ? <p role="alert" className="mb-4 typography-meta text-[var(--status-error-text)]">{t('bots.error')}</p> : null}
    {item.wait ? <section aria-label={t('bots.wait')} className="oc-tile mb-4 rounded-lg p-3 typography-meta space-y-1">
      <h3 className="font-medium">{t('bots.wait')} · {item.wait.channel}</h3>
      <p dir="auto" className="whitespace-pre-wrap break-words">{item.wait.reason}</p>
      <p>{new Date(item.wait.since).toLocaleString(locale)} · {item.wait.people.join(', ')}</p>
    </section> : null}
    {!archived && !isTerminalBotItem(item) ? <div className="mb-4 space-y-3">
      <div className="flex flex-wrap gap-2">
        {item.state === 'needs-you' ? <Button size="sm" disabled={action.busy} onClick={() => void operate('resume')}>{t('bots.resume')}</Button> : null}
        <Button size="sm" variant="destructive" disabled={action.busy} onClick={() => void operate('stop')}>{t('bots.stop')}</Button>
      </div>
      {item.state === 'needs-you' || item.state === 'waiting-answer' ? <SettingsStackedField label={t('bots.answer')} controlClassName="max-w-none w-full flex-col items-stretch">
        <Textarea aria-label={t('bots.answer')} value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={action.busy} />
        <Button className="self-start" size="sm" disabled={action.busy || !answer.trim()} onClick={() => void operate('answer')}>{t('bots.answer')}</Button>
      </SettingsStackedField> : null}
      <div className="min-h-5 typography-meta text-[var(--status-error-text)]" role="alert">{action.error}</div>
    </div> : null}
    <BotEvidence item={item} />
    <SettingsSection title={t('bots.sessions')} contentClassName="space-y-2 typography-meta">
      <p className="break-all font-mono" dir="ltr">{item.worktree} {item.branch}</p>
      {(['investigation', 'fixing', 'judge'] as const).map((stage) => {
        const sessionId = item.sessions[stage];
        return <div key={stage} className="flex min-w-0 items-center gap-3">
          <span className="shrink-0">{t(`bots.${stage}`)} · {item.tokens.byStage[stage]}</span>
          {sessionId ? <Button variant="link" size="sm" className="min-w-0 shrink" disabled={!read.data || !Object.hasOwn(read.data.sessionDirectories, sessionId)} onClick={() => openSession(sessionId)}><span className="truncate" dir="ltr">{sessionId}</span></Button> : <span className="text-muted-foreground">{t('bots.none')}</span>}
        </div>;
      })}
      {item.pr ? <div className="space-y-1"><BotLink url={item.pr.url}>PR #{item.pr.number}</BotLink><p className="break-all font-mono" dir="ltr">{item.pr.baseSha} / {item.pr.headSha}</p></div> : null}
    </SettingsSection>
    <SettingsSection title={t('bots.timeline')} contentClassName="space-y-3 typography-meta">
      <ol className="space-y-3">{item.transitions.map((entry) => <li key={entry.revision} className="min-w-0 space-y-1">
        <p><time>{new Date(entry.at).toLocaleString(locale)}</time> · <BotStateLabel state={entry.to} /></p>
        <p className="whitespace-pre-wrap break-words" dir="auto">{entry.reason}</p>
      </li>)}</ol>
    </SettingsSection>
    <SettingsSection title={t('bots.effects')} contentClassName="space-y-2 typography-meta">
      {item.effects.map((effect) => <details key={effect.key} className="min-w-0">
        <summary className="cursor-pointer break-words py-1" dir="auto">{effect.kind} · {effect.state}</summary>
        <pre className="whitespace-pre-wrap break-all font-mono" dir="ltr">{JSON.stringify(effect, null, 2)}</pre>
      </details>)}
    </SettingsSection>
    <SettingsSection title={t('bots.stageReports')} contentClassName="space-y-3 typography-meta">
      {read.data ? <>
        {Object.entries(read.data.reports).map(([stage, report]) => <details key={stage}><summary className="cursor-pointer py-1">{stage}</summary><pre dir="auto" className="whitespace-pre-wrap break-words">{JSON.stringify(report, null, 2)}</pre></details>)}
        {read.data.snapshot ? <pre dir="ltr" className="whitespace-pre-wrap break-words font-mono">{read.data.snapshot.diff}</pre> : null}
      </> : <p className="text-muted-foreground">{read.busy ? t('common.loading') : t('common.unavailable')}</p>}
    </SettingsSection>
  </div>;
}
