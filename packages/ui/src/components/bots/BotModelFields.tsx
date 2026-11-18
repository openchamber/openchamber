import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { SettingsCheckboxRow, SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import type { BotDefinition, BotModel } from '@/lib/bots/config';

export function BotModelFields({ bot, directory, onChange }: {
  readonly bot: BotDefinition; readonly directory: string; readonly onChange: (models: BotDefinition['models']) => void;
}) {
  const { t } = useI18n();
  return <>{(['investigation', 'fixing', 'judge'] as const).map((stage, index) => {
    const model = bot.models[stage];
    const update = (patch: Partial<BotModel>) => onChange({ ...bot.models, [stage]: { ...model, ...patch } });
    return <SettingsSection key={stage} title={t(`bots.${stage}`)} divider={index > 0} contentClassName="space-y-4">
      <SettingsCheckboxRow label={t('suggestedTasks.lens.editor.useDefaults')} checked={model.useDefaults} onChange={(useDefaults) => update({ useDefaults })} />
      {!model.useDefaults ? <div className="space-y-4 ps-6">
        <SettingsStackedField label={t('suggestedTasks.lens.editor.model')}>
          <ModelSelector directory={directory} providerId={model.providerID ?? ''} modelId={model.modelID ?? ''} onChange={(providerID, modelID) => update({ providerID, modelID, variant: undefined })} />
        </SettingsStackedField>
        <SettingsStackedField label={t('suggestedTasks.lens.editor.variant')}>
          <Input aria-label={t('suggestedTasks.lens.editor.variant')} value={model.variant ?? ''} onChange={(event) => update({ variant: event.target.value || undefined })} />
        </SettingsStackedField>
        <SettingsStackedField label={t('suggestedTasks.lens.editor.agent')}>
          <AgentSelector directory={directory} agentName={model.agent ?? ''} onChange={(agent) => update({ agent: agent || undefined })} />
        </SettingsStackedField>
      </div> : null}
    </SettingsSection>;
  })}</>;
}
