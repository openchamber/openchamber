import React from 'react';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip } from '@/components/ui/sortable-tabs-strip';
import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { McpToolPermissionsEditor } from '@/components/sections/shared/McpToolPermissionsEditor';
import { useI18n } from '@/lib/i18n';
import { botDefinitionSchema, type BotDefinition } from '@/lib/bots/config';
import { BotSourceFields } from './BotSourceFields';
import { BotModelFields } from './BotModelFields';
import { BotExecutionFields } from './BotExecutionFields';
import { BotIdentityFields } from './BotIdentityFields';
import { BotDiscordFields } from './BotDiscordFields';
import { useBotAction } from './useBotRequest';

export function BotEditor({ projectId, directory, initial, onSave, onClose, onManageIdentities, identitiesVersion }: {
  readonly projectId: string; readonly directory: string; readonly initial: BotDefinition;
  readonly onSave: (bot: BotDefinition) => Promise<void>; readonly onClose: () => void; readonly onManageIdentities: () => void;
  readonly identitiesVersion: number;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = React.useState(initial);
  const [tab, setTab] = React.useState('mission');
  const action = useBotAction();
  const update = (patch: Partial<BotDefinition>) => setDraft((bot) => ({ ...bot, ...patch }));
  const save = () => action.run(async () => {
    await onSave(botDefinitionSchema.parse(draft));
    if (action.isActive()) onClose();
  });
  return <div className="@container space-y-4">
    <div className="flex min-w-0 items-center justify-between gap-3">
      <Button variant="ghost" size="sm" onClick={onClose} disabled={action.busy}>{t('bots.back')}</Button>
      <Button size="sm" disabled={action.busy} onClick={() => void save()}>{t('settings.common.actions.saveChanges')}</Button>
    </div>
    <div className="min-h-5 typography-meta" role="alert">{action.error ? <span className="text-[var(--status-error-text)]">{action.error}</span> : null}</div>
    <SortableTabsStrip variant="active-pill" pillSize="form" className="h-8" activeId={tab} onSelect={setTab} items={[
      { id: 'mission', label: t('bots.mission') }, { id: 'models', label: t('bots.models') },
      { id: 'tools', label: t('mcpToolPermissions.title') }, { id: 'execution', label: t('bots.execution') },
    ]} />
    <fieldset disabled={action.busy} className="min-w-0">
      {tab === 'mission' ? <BotSourceFields bot={draft} onChange={update} /> : null}
      {tab === 'models' ? <BotModelFields bot={draft} directory={directory} onChange={(models) => update({ models })} /> : null}
      {tab === 'tools' ? <>
        <SettingsSection title={t('bots.investigation')} divider={false} contentClassName="space-y-4">
          <p className="typography-meta text-[var(--status-warning-text)]">{t('bots.mcpWarning')}</p>
          <SettingsCheckboxRow label={t('suggestedTasks.lens.editor.web')} checked={draft.web} onChange={(web) => update({ web })} />
          <McpToolPermissionsEditor projectId={projectId} value={draft.mcp} onChange={(mcp) => update({ mcp })} />
        </SettingsSection>
        <SettingsSection title={t('bots.correctionMcp')}>
          <McpToolPermissionsEditor projectId={projectId} value={draft.correctionMcp} onChange={(correctionMcp) => update({ correctionMcp })} />
        </SettingsSection>
      </> : null}
      {tab === 'execution' ? <>
        <BotExecutionFields bot={draft} directory={directory} onChange={update} />
        <BotIdentityFields key={identitiesVersion} projectId={projectId} value={draft.identity} onChange={(identity) => update({ identity })} onManage={onManageIdentities} />
        <BotDiscordFields value={draft.discord} onChange={(discord) => update({ discord })} />
      </> : null}
    </fieldset>
  </div>;
}
