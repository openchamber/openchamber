import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fetchBotArchive } from '@/lib/botsApi';
import type { BotItem } from '@/lib/bots/items';
import { useI18n } from '@/lib/i18n';
import { useBotResource } from './useBotRequest';
import { BotItemList } from './BotItemList';

export function BotArchive({ projectId, onOpen }: { readonly projectId: string; readonly onOpen: (item: BotItem) => void }) {
  const { t } = useI18n();
  const [month, setMonth] = React.useState(() => new Date().toISOString().slice(0, 7));
  const [selectedMonth, setSelectedMonth] = React.useState(month);
  const load = React.useCallback(() => fetchBotArchive(projectId, selectedMonth), [projectId, selectedMonth]);
  const read = useBotResource(load);
  return <div className="space-y-4">
    <form className="flex min-w-0 items-center gap-2" onSubmit={(event) => { event.preventDefault(); setSelectedMonth(month); read.refresh(); }}>
      <Input inputSize="compact" className="w-fit" type="month" required dir="ltr" aria-label={t('bots.month')} value={month} onChange={(event) => setMonth(event.target.value)} />
      <Button size="sm" variant="outline" type="submit" disabled={read.busy || !/^\d{4}-\d{2}$/.test(month)}>{t('bots.refresh')}</Button>
    </form>
    {read.error ? <p role="alert" className="typography-meta text-[var(--status-error-text)]">{t('bots.error')}</p> : null}
    {read.busy && !read.data ? <p role="status" className="typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {read.data ? <BotItemList items={read.data.items} onOpen={onOpen} audit /> : null}
  </div>;
}
