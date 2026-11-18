import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { createBotItem, type CreateBotItem } from '@/lib/botsApi';
import type { BotDefinition } from '@/lib/bots/config';
import type { BotItem, BotEvidence, BotSource } from '@/lib/bots/items';
import { useI18n } from '@/lib/i18n';
import { BotSelectField } from './BotFields';
import { useBotAction } from './useBotRequest';

export function BotItemCreate({ projectId, bots, initial, onCreated, onClose }: {
  readonly projectId: string; readonly bots: readonly BotDefinition[];
  readonly initial?: Omit<CreateBotItem, 'botId'>; readonly onCreated: (item: BotItem) => void; readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [botId, setBotId] = React.useState(bots.find((bot) => bot.enabled)?.id ?? '');
  const [source, setSource] = React.useState<BotSource>(initial?.source ?? { kind: 'manual', id: crypto.randomUUID() });
  const [title, setTitle] = React.useState(initial?.title ?? '');
  const [description, setDescription] = React.useState(initial?.description ?? '');
  const [evidence, setEvidence] = React.useState<readonly BotEvidence[]>(initial?.evidence ?? []);
  const action = useBotAction();
  const submit = () => action.run(async () => {
    const result = await createBotItem(projectId, { botId, source, title: title.trim(), description, evidence });
    if (action.isActive()) onCreated(result.item);
  });
  return <div className="@container space-y-4">
    <div className="flex items-center justify-between gap-3">
      <Button size="sm" variant="ghost" disabled={action.busy} onClick={onClose}>{t('bots.back')}</Button>
      <Button size="sm" disabled={action.busy || !botId || !title.trim() || !source.id.trim()} onClick={() => void submit()}>{t('bots.newItem')}</Button>
    </div>
    <div className="min-h-5 typography-meta text-[var(--status-error-text)]" role="alert">{action.error}</div>
    <SettingsSection title={t('bots.newItem')} divider={false} contentClassName="space-y-4">
      <BotSelectField label={t('bots.title')} value={botId} options={bots.map((bot) => ({ value: bot.id, label: bot.name, disabled: !bot.enabled }))} onChange={setBotId} />
      <SettingsStackedField label={t('bots.name')}><Input required aria-label={t('bots.name')} value={title} onChange={(event) => setTitle(event.target.value)} /></SettingsStackedField>
      <SettingsStackedField label={t('settings.common.field.description')} controlClassName="max-w-none w-full"><Textarea aria-label={t('settings.common.field.description')} value={description} onChange={(event) => setDescription(event.target.value)} /></SettingsStackedField>
      <BotSelectField<BotSource['kind']> label={t('bots.source')} value={source.kind} disabled={Boolean(initial)} onChange={(kind) => setSource({ ...source, kind })} options={[
        { value: 'manual', label: t('bots.manual') }, { value: 'jira', label: 'Jira' }, { value: 'investigation', label: t('bots.investigation') },
        { value: 'suggestion', label: t('suggestedTasks.page.title') }, { value: 'alert', label: t('bots.attention') },
      ]} />
      <SettingsStackedField label={t('bots.sourceId')}><Input dir="ltr" required readOnly={Boolean(initial)} aria-label={t('bots.sourceId')} value={source.id} onChange={(event) => setSource({ ...source, id: event.target.value })} /></SettingsStackedField>
      <SettingsStackedField label={t('bots.url')}><Input dir="ltr" type="url" aria-label={t('bots.url')} value={source.url ?? ''} onChange={(event) => setSource({ ...source, url: event.target.value || undefined })} /></SettingsStackedField>
    </SettingsSection>
    <SettingsSection title={t('bots.evidence')} headerAction={<Button size="sm" variant="outline" onClick={() => setEvidence([...evidence, { source: '', summary: '' }])}>{t('settings.common.actions.create')}</Button>} contentClassName="space-y-5">
      {evidence.map((entry, index) => {
        const update = (patch: Partial<BotEvidence>) => setEvidence(evidence.map((value, position) => position === index ? { ...value, ...patch } : value));
        return <div key={index} className="space-y-3">
          <SettingsStackedField label={t('bots.source')}><Input required aria-label={t('bots.source')} value={entry.source} onChange={(event) => update({ source: event.target.value })} /></SettingsStackedField>
          <SettingsStackedField label={t('bots.evidence')} controlClassName="max-w-none w-full"><Textarea required aria-label={t('bots.evidence')} value={entry.summary} onChange={(event) => update({ summary: event.target.value })} /></SettingsStackedField>
          <SettingsStackedField label={t('bots.url')}><Input dir="ltr" type="url" aria-label={t('bots.url')} value={entry.url ?? ''} onChange={(event) => update({ url: event.target.value || undefined })} /></SettingsStackedField>
          <Button size="sm" variant="ghost" onClick={() => setEvidence(evidence.filter((_, position) => position !== index))}>{t('settings.common.actions.delete')}</Button>
        </div>;
      })}
    </SettingsSection>
  </div>;
}
