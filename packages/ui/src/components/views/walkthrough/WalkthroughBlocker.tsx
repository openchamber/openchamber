import { useCallback, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCallableModelProviders } from '@/hooks/useCallableModelProviders';
import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { updateDesktopSettings } from '@/lib/persistence';
import type { WalkthroughBlockedState, WalkthroughModel } from '@/lib/walkthrough/types';

interface WalkthroughBlockerProps {
  reason: WalkthroughBlockedState;
  model?: WalkthroughModel;
  requiredChars?: number;
  availableChars?: number;
  onRetry: () => void;
}

const modelLabel = (model?: WalkthroughModel) =>
  model ? `${model.providerID}/${model.modelID}` : '';

export const WalkthroughBlocker = ({
  reason,
  model,
  requiredChars,
  availableChars,
  onRetry,
}: WalkthroughBlockerProps) => {
  const { t } = useI18n();
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
  const [saving, setSaving] = useState(false);

  const canChooseModel = reason === 'context-too-small'
    || reason === 'structured-output-unsupported'
    || reason === 'output-exhausted';
  const providers = useCallableModelProviders(canChooseModel);

  const handleModelChange = useCallback(
    async (providerId: string, modelId: string) => {
      if (!providerId || !modelId || saving) return;
      const value = `${providerId}/${modelId}`;
      setSaving(true);
      try {
        await updateDesktopSettings({ walkthroughModelOverride: value, walkthroughModelVariant: '' });
        onRetry();
      } catch (error) {
        console.warn('Failed to save small model override:', error);
      } finally {
        setSaving(false);
      }
    },
    [onRetry, saving]
  );

  const isStructuredOutputCapable = useCallback(
    (providerId: string, modelId: string) =>
      modelsMetadata.get(`${providerId}/${modelId}`)?.structured_output !== false,
    [modelsMetadata]
  );

  const label = modelLabel(model);

  const description = () => {
    if (reason === 'no-model') return t('walkthrough.blocked.noModel.description');
    if (reason === 'empty-diff') return t('walkthrough.blocked.emptyDiff.description');
    if (reason === 'only-generated') return t('walkthrough.blocked.onlyGenerated.description');
    if (reason === 'server-unsupported') return t('walkthrough.blocked.serverUnsupported.description');
    if (reason === 'output-exhausted') {
      return label
        ? t('walkthrough.blocked.outputExhausted.description', { model: label })
        : t('walkthrough.blocked.outputExhausted.descriptionUnknownModel');
    }
    if (reason === 'structured-output-unsupported') {
      return label
        ? t('walkthrough.blocked.structuredOutput.description', { model: label })
        : t('walkthrough.blocked.structuredOutput.descriptionUnknownModel');
    }
    const required = Math.ceil((requiredChars ?? 0) / 1000);
    const available = Math.ceil((availableChars ?? 0) / 1000);
    return label
      ? t('walkthrough.blocked.contextTooSmall.description', { model: label, required, available })
      : t('walkthrough.blocked.contextTooSmall.descriptionUnknownModel', { required, available });
  };

  const title = () => {
    if (reason === 'no-model') return t('walkthrough.blocked.noModel.title');
    if (reason === 'empty-diff') return t('walkthrough.blocked.emptyDiff.title');
    if (reason === 'only-generated') return t('walkthrough.blocked.onlyGenerated.title');
    if (reason === 'server-unsupported') return t('walkthrough.blocked.serverUnsupported.title');
    if (reason === 'output-exhausted') return t('walkthrough.blocked.outputExhausted.title');
    if (reason === 'structured-output-unsupported') return t('walkthrough.blocked.structuredOutput.title');
    return t('walkthrough.blocked.contextTooSmall.title');
  };

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <Icon
        name={reason === 'empty-diff' || reason === 'only-generated' ? 'information' : 'error-warning'}
        className="size-6 text-muted-foreground"
      />
      <h3 className="typography-ui-label font-semibold text-foreground">{title()}</h3>
      <p className="typography-meta max-w-md text-muted-foreground">{description()}</p>

      {canChooseModel && (
        <div className="flex flex-col items-center gap-2 pt-2">
          <span className="typography-micro text-muted-foreground">
            {t('walkthrough.blocked.chooseModel')}
          </span>
          <ModelSelector
            providerId={model?.providerID ?? ''}
            modelId={model?.modelID ?? ''}
            onChange={(providerId, modelId) => {
              void handleModelChange(providerId, modelId);
            }}
            allowedProviderIds={providers ?? []}
            isModelAllowed={isStructuredOutputCapable}
            triggerTooltip={t('contextTooltips.panel.chooseWalkthroughModel')}
          />
        </div>
      )}

      {(reason === 'empty-diff' || reason === 'only-generated' || reason === 'server-unsupported') && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t('walkthrough.action.refresh')}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.walkthrough.checkAgain')}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
