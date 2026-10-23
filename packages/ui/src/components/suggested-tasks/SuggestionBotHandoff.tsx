import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { fetchBots } from '@/lib/botsApi';
import type { BotDefinition } from '@/lib/bots/config';
import { getSuggestedTasksRuntime } from '@/lib/suggestedTasksRuntime';
import { useI18n } from '@/lib/i18n';

type BotChoices =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly bots: readonly BotDefinition[] };

/** Mounted only after an explicit handoff click, for this project's inbox visit. */
export function SuggestionBotHandoff({ projectId, title, lockedBotId, busy, error, onHandoff, onClose }: {
  readonly projectId: string; readonly title: string; readonly lockedBotId?: string;
  readonly busy: boolean; readonly error: string | null;
  readonly onHandoff: (botId: string) => Promise<boolean>; readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [choices, setChoices] = React.useState<BotChoices>({ status: 'loading' });
  const [selectedId, setSelectedId] = React.useState(lockedBotId ?? '');
  const [revision, setRevision] = React.useState(0);
  React.useEffect(() => {
    let active = true;
    const runtime = getSuggestedTasksRuntime();
    setChoices({ status: 'loading' });
    void fetchBots(projectId).then((snapshot) => {
      if (active && !runtime.signal.aborted) setChoices({ status: 'ready', bots: snapshot.config.definitions.filter((bot) => bot.enabled) });
    }, () => {
      if (active && !runtime.signal.aborted) setChoices({ status: 'error' });
    });
    return () => { active = false; };
  }, [projectId, revision]);

  const bots = choices.status === 'ready' ? choices.bots : [];
  const botId = lockedBotId ?? selectedId;
  const selected = bots.find((bot) => bot.id === botId);
  const status = choices.status === 'loading' ? t('common.loading')
    : choices.status === 'error' ? t('suggestedTasks.botHandoff.loadFailed')
      : bots.length === 0 ? t('suggestedTasks.botHandoff.empty') : lockedBotId ? t('suggestedTasks.botHandoff.locked') : '';
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <DialogContent showCloseButton={!busy} className="max-w-lg" aria-busy={busy}>
      <DialogHeader>
        <DialogTitle>{t('suggestedTasks.action.bot')}</DialogTitle>
        <DialogDescription className="break-words oc-ui-start-align" dir="auto">{title}</DialogDescription>
      </DialogHeader>
      <p className="typography-meta text-muted-foreground">{t('suggestedTasks.botHandoff.description')}</p>
      <SettingsStackedField label={t('suggestedTasks.botHandoff.bot')}>
        <Select value={botId} onValueChange={setSelectedId} disabled={busy || Boolean(lockedBotId) || !bots.length}>
          <SelectTrigger className="max-w-full" aria-label={t('suggestedTasks.botHandoff.bot')}>
            <SelectValue><span dir="auto">{selected?.name ?? (botId || t('suggestedTasks.botHandoff.bot'))}</span></SelectValue>
          </SelectTrigger>
          <SelectContent>{bots.map((bot) => <SelectItem key={bot.id} value={bot.id}><span dir="auto">{bot.name}</span></SelectItem>)}</SelectContent>
        </Select>
      </SettingsStackedField>
      <div className="min-h-5 typography-meta" role={error || choices.status === 'error' ? 'alert' : 'status'}>
        <p className={error ? 'break-words text-[var(--status-error-text)]' : 'text-muted-foreground'}>{error ? t('suggestedTasks.botHandoff.failed', { error }) : status}</p>
      </div>
      <DialogFooter>
        <Button size="sm" variant="outline" disabled={busy} onClick={onClose}>{t('dialog.common.actions.cancel')}</Button>
        {choices.status === 'error' ? <Button size="sm" onClick={() => setRevision((value) => value + 1)}>{t('suggestedTasks.error.retry')}</Button>
          : <Button size="sm" disabled={busy || !selected} onClick={() => void onHandoff(botId)}>{t('suggestedTasks.action.bot')}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
