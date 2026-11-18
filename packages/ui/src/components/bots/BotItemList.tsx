import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n, type I18nKey } from '@/lib/i18n';
import type { BotItem, BotState } from '@/lib/bots/items';

const stateKeys = {
  queued: 'bots.state.queued', investigating: 'bots.state.investigating', 'waiting-answer': 'bots.state.waiting-answer',
  fixing: 'bots.state.fixing', proving: 'bots.state.proving', judging: 'bots.state.judging', 'in-review': 'bots.state.in-review',
  merging: 'bots.state.merging', closing: 'bots.state.closing', done: 'bots.state.done', 'needs-you': 'bots.state.needs-you',
  failed: 'bots.state.failed', stopped: 'bots.state.stopped',
} satisfies Record<BotState, I18nKey>;

export function BotStateLabel({ state }: { readonly state: BotState }) {
  const { t } = useI18n();
  return <span className={state === 'needs-you' || state === 'waiting-answer' ? 'text-[var(--status-warning-text)]' : state === 'failed' ? 'text-[var(--status-error-text)]' : 'text-muted-foreground'}>{t(stateKeys[state])}</span>;
}

export function BotItemList({ items, onOpen, audit = false }: {
  readonly items: readonly BotItem[]; readonly onOpen: (item: BotItem) => void; readonly audit?: boolean;
}) {
  const { t } = useI18n();
  if (items.length === 0) return <p className="py-4 typography-meta text-muted-foreground">{t('bots.empty')}</p>;
  return <div className="space-y-2">{items.map((item) => <article key={item.id} className="oc-tile min-w-0 rounded-lg p-3">
    <div className="flex min-w-0 items-center gap-3">
      <Button variant="link" size="sm" className="min-w-0 shrink justify-start truncate p-0 text-foreground" onClick={() => onOpen(item)} title={item.title}>
        <span dir="auto" className="truncate oc-ui-start-align">{item.title}</span>
      </Button>
      <span className="ms-auto shrink-0 typography-meta"><BotStateLabel state={item.state} /></span>
    </div>
    <p className="mt-1 typography-meta text-muted-foreground" dir="auto">{t('bots.tokens', { count: item.tokens.total })}</p>
    {audit ? <div className="mt-2 space-y-1 typography-meta">
      <p className={item.proof.status === 'absent' ? 'text-[var(--status-warning-text)]' : 'text-foreground'}>
        {item.proof.status === 'absent' ? t('bots.proofAbsent') : item.proof.status === 'passed' ? t('bots.proofPassed') : item.proof.status === 'failed' ? t('bots.proofFailed') : t('bots.proofInconclusive')}
        {item.proof.reason ? ` · ${item.proof.reason}` : ''}
      </p>
      <p dir="auto" className="whitespace-pre-wrap break-words">{item.judgment ? `${t('bots.judgment')} · ${item.judgment.decision} · ${item.judgment.reason}` : t('bots.noJudgment')}</p>
    </div> : null}
  </article>)}</div>;
}
