import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { SettingsSection, SettingsStackedField, SettingsTwoColumn } from '@/components/sections/shared/SettingsSection';
import { NumberInput } from '@/components/ui/number-input';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { fetchBots, runBot, saveBotsConfig, type BotsSnapshot } from '@/lib/botsApi';
import { botDefinitionSchema, newBotDraft, type BotDefinition } from '@/lib/bots/config';
import type { ProjectEntry } from '@/lib/api/types';
import type { BotItem } from '@/lib/bots/items';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { getBotsRuntime } from '@/lib/botsRuntime';
import { useUIStore } from '@/stores/useUIStore';
import { BotEditor } from './BotEditor';
import { BotItemList } from './BotItemList';
import { BotItemDetail } from './BotItemDetail';
import { BotItemCreate } from './BotItemCreate';
import { BotPolicy } from './BotPolicy';
import { BotIdentities } from './BotIdentities';
import { BotArchive } from './BotArchive';
import { useBotAction, useBotResource, useBotsRefresh } from './useBotRequest';

type Detail = { readonly item: BotItem; readonly archived: boolean };
const presetLabels = new Map<string, I18nKey>([
  ['jira-bugs', 'bots.preset.jira-bugs'], ['security-infra', 'bots.preset.security-infra'],
  ['dependencies', 'bots.preset.dependencies'], ['performance', 'bots.preset.performance'], ['repository-rules', 'bots.preset.repository-rules'],
]);
export function BotsProject({ project, onLeave, initialItemId, initialBotId, onViewChange }: {
  readonly project: ProjectEntry; readonly onLeave: () => void; readonly initialItemId?: string; readonly initialBotId?: string;
  readonly onViewChange?: () => void;
}) {
  const { t } = useI18n();
  const load = React.useCallback(() => fetchBots(project.id), [project.id]);
  const read = useBotResource(load);
  const snapshot = read.data;
  const [tab, setTab] = React.useState('items');
  const [editor, setEditor] = React.useState<BotDefinition | null>(null);
  const [detail, setDetail] = React.useState<Detail | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [configure, setConfigure] = React.useState(false);
  const [managingIdentities, setManagingIdentities] = React.useState(false);
  const [identitiesVersion, setIdentitiesVersion] = React.useState(0);
  const [targetUnavailable, setTargetUnavailable] = React.useState(false);
  React.useLayoutEffect(() => { onViewChange?.(); }, [onViewChange, tab, editor?.id, detail?.item.id, detail?.archived, creating]);
  const action = useBotAction();
  useBotsRefresh(project.id, read.refresh, !detail && !editor && !creating);
  React.useEffect(() => {
    if ((!initialItemId && !initialBotId) || !snapshot) return;
    const item = snapshot.items.find((entry) => entry.id === initialItemId);
    const bot = snapshot.config.definitions.find((entry) => entry.id === initialBotId);
    setEditor(null);
    setDetail(null);
    setCreating(false);
    setTargetUnavailable(!item && !bot);
    if (item) setDetail({ item, archived: false });
    else if (bot) setEditor(bot);
    useUIStore.getState().setBotsPageTarget(null);
  }, [initialItemId, initialBotId, snapshot]);
  const saveBot = async (bot: BotDefinition) => {
    if (!snapshot) return;
    const runtime = getBotsRuntime();
    const existing = snapshot.config.definitions.some((entry) => entry.id === bot.id);
    const definitions = existing ? snapshot.config.definitions.map((entry) => entry.id === bot.id ? bot : entry) : [...snapshot.config.definitions, bot];
    const result = await saveBotsConfig(project.id, { ...snapshot.config, definitions });
    if (!runtime.signal.aborted) read.replace({ ...snapshot, config: result.config });
  };
  if (editor) return <>
    <BotEditor key={editor.id} projectId={project.id} directory={project.path} initial={editor} onSave={saveBot} onClose={() => setEditor(null)} identitiesVersion={identitiesVersion} onManageIdentities={() => setManagingIdentities(true)} />
    <Dialog open={managingIdentities} onOpenChange={(open) => { setManagingIdentities(open); if (!open) setIdentitiesVersion((version) => version + 1); }}>
      <DialogContent className="max-w-3xl max-h-[90dvh] overflow-y-auto"><DialogTitle>{t('bots.identities')}</DialogTitle>{managingIdentities ? <BotIdentities projectId={project.id} /> : null}</DialogContent>
    </Dialog>
  </>;
  if (detail) return <BotItemDetail key={detail.item.id} projectId={project.id} initial={detail.item} archived={detail.archived} onBack={() => { setDetail(null); read.refresh(); }} onLeave={onLeave} />;
  if (creating && snapshot) return <BotItemCreate projectId={project.id} bots={snapshot.config.definitions} onCreated={(item) => { setCreating(false); setDetail({ item, archived: false }); read.refresh(); }} onClose={() => setCreating(false)} />;
  const today = new Date().toISOString().slice(0, 10);
  const attention = snapshot?.items.filter((item) => item.state === 'needs-you' || item.state === 'waiting-answer') ?? [];
  return <div className="min-w-0 @container space-y-4">
    <div className="flex min-w-0 items-center gap-2">
      <Button size="sm" onClick={() => setEditor(newBotDraft())} disabled={!snapshot}>{t('bots.newBot')}</Button>
      <Button size="sm" variant="outline" disabled={!snapshot?.config.definitions.length} onClick={() => setCreating(true)}>{t('bots.newItem')}</Button>
      <Button size="sm" variant="ghost" className="ms-auto" aria-pressed={configure} onClick={() => setConfigure((value) => !value)} disabled={!snapshot}><Icon name="settings-3" className="size-4" /><span className="sr-only">{t('bots.configure')}</span></Button>
      <Button size="sm" variant="ghost" disabled={read.busy} onClick={read.refresh} aria-label={t('bots.refresh')}><Icon name="refresh" className="size-4" /></Button>
    </div>
    <div className="min-h-5 typography-meta" role={read.error || action.error ? 'alert' : 'status'}>
      {read.error || action.error ? <p className="text-[var(--status-error-text)]">{action.error ?? t('bots.error')}</p> : snapshot ? t('bots.tokensToday', { count: snapshot.items.reduce((sum, item) => sum + (item.tokens.byDay[today] ?? 0), 0) }) : t('common.loading')}
    </div>
    {targetUnavailable ? <p role="alert" className="typography-meta text-[var(--status-warning-text)]">{t('common.unavailable')}</p> : null}
    {configure && snapshot ? <BotsProjectConfig projectId={project.id} snapshot={snapshot} onSaved={(config) => read.replace({ ...snapshot, config })} /> : null}
    <SortableTabsStrip className="h-7" variant="active-pill" activeId={tab} onSelect={setTab} items={[
      { id: 'items', label: t('bots.items') }, { id: 'audit', label: t('bots.audit') }, { id: 'rules', label: t('bots.rules') },
      { id: 'identities', label: t('bots.identities') }, { id: 'archive', label: t('bots.archive') },
    ]} />
    {tab === 'items' && snapshot ? <>
      {attention.length ? <SettingsSection title={t('bots.attention')} divider={false}><BotItemList items={attention} onOpen={(item) => setDetail({ item, archived: false })} /></SettingsSection> : null}
      <SettingsSection title={t('bots.title')} divider={false} contentClassName="space-y-2">
        {snapshot.config.definitions.map((bot) => <article key={bot.id} className="oc-tile rounded-lg p-3">
          <div className="flex min-w-0 items-center gap-2"><span className="min-w-0 flex-1 truncate typography-ui-label" dir="auto" title={bot.name}>{bot.name}</span>
            <Button size="sm" variant="outline" disabled={action.busy || !bot.enabled} onClick={() => void action.run(async () => { await runBot(project.id, bot.id); if (action.isActive()) read.refresh(); })}>{t('bots.run')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setEditor(bot)}>{t('bots.edit')}</Button>
          </div>
          <p className="mt-1 truncate typography-meta text-muted-foreground" dir="auto" title={bot.mission}>{bot.mission}</p>
        </article>)}
        {snapshot.config.definitions.length === 0 ? <p className="typography-meta text-muted-foreground">{t('bots.empty')}</p> : null}
        {snapshot.presets.length ? <div className="flex flex-wrap gap-2 pt-2">{snapshot.presets.map((preset) => {
          const key = presetLabels.get(preset.id);
          const name = key ? t(key) : preset.name;
          return <Button key={preset.id} size="sm" variant="chip" onClick={() => setEditor(botDefinitionSchema.parse({ ...preset, id: crypto.randomUUID(), name }))}>{name}</Button>;
        })}</div> : null}
      </SettingsSection>
      <SettingsSection title={t('bots.items')}><BotItemList items={snapshot.items.filter((item) => !attention.includes(item))} onOpen={(item) => setDetail({ item, archived: false })} /></SettingsSection>
    </> : null}
    {tab === 'audit' && snapshot ? <BotItemList items={snapshot.items} onOpen={(item) => setDetail({ item, archived: false })} audit /> : null}
    {tab === 'rules' ? <BotPolicy projectId={project.id} /> : null}
    {tab === 'identities' ? <BotIdentities projectId={project.id} /> : null}
    {tab === 'archive' ? <BotArchive projectId={project.id} onOpen={(item) => setDetail({ item, archived: true })} /> : null}
  </div>;
}

function BotsProjectConfig({ projectId, snapshot, onSaved }: {
  readonly projectId: string; readonly snapshot: BotsSnapshot; readonly onSaved: (config: BotsSnapshot['config']) => void;
}) {
  const { t } = useI18n();
  const [concurrency, setConcurrency] = React.useState(snapshot.config.concurrency);
  const [retentionDays, setRetention] = React.useState(snapshot.config.retentionDays);
  const action = useBotAction();
  return <SettingsSection title={t('bots.configure')} divider={false} contentClassName="space-y-3">
    <SettingsTwoColumn>
      <SettingsStackedField label={t('bots.concurrency')}><NumberInput aria-label={t('bots.concurrency')} value={concurrency} min={1} onValueChange={setConcurrency} /></SettingsStackedField>
      <SettingsStackedField label={t('bots.retention')}><NumberInput aria-label={t('bots.retention')} value={retentionDays} min={0} onValueChange={setRetention} /></SettingsStackedField>
    </SettingsTwoColumn>
    <Button size="sm" disabled={action.busy} onClick={() => void action.run(async () => { const result = await saveBotsConfig(projectId, { ...snapshot.config, concurrency, retentionDays }); if (action.isActive()) onSaved(result.config); })}>{t('settings.common.actions.saveChanges')}</Button>
    <div className="min-h-5 typography-meta text-[var(--status-error-text)]" role="alert">{action.error}</div>
  </SettingsSection>;
}
