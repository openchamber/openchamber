import { useCallback, useEffect, useState } from 'react';
import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { updateDesktopSettings } from '@/lib/persistence';
import type { WalkthroughBlockedReason, WalkthroughModel } from '@/lib/walkthrough/types';

interface WalkthroughBlockerProps {
  reason: WalkthroughBlockedReason;
  model?: WalkthroughModel;
  requiredChars?: number;
  availableChars?: number;
  onRetry: () => void;
}

const modelLabel = (model?: WalkthroughModel) =>
  model ? `${model.providerID}/${model.modelID}` : '';

/**
 * A refusal the user can act on. Both blocking reasons come down to "this small
 * model cannot do this job", so the remedy — pick a different one — is offered
 * in place rather than sending the user to Settings to guess.
 */
export const WalkthroughBlocker = ({
  reason,
  model,
  requiredChars,
  availableChars,
  onRetry,
}: WalkthroughBlockerProps) => {
  const { t } = useI18n();
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);
  const [providers, setProviders] = useState<string[] | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  // Every one of these means "this small model cannot do this job", so the
  // remedy is the same: choose a different one, here, without a detour through
  // Settings.
  const canChooseModel = reason === 'context-too-small'
    || reason === 'structured-output-unsupported'
    || reason === 'output-exhausted';

  useEffect(() => {
    if (!canChooseModel || providers !== undefined) return;
    let cancelled = false;
    (async () => {
      try {
        const response = await runtimeFetch('/api/small-model', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return;
        const payload = (await response.json().catch(() => null)) as
          | { authenticatedProviders?: unknown }
          | null;
        if (!cancelled && Array.isArray(payload?.authenticatedProviders)) {
          setProviders(payload.authenticatedProviders.filter((id): id is string => typeof id === 'string'));
        }
      } catch {
        // Leave undefined: the picker then offers every provider, which is a
        // worse experience but not a broken one.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [canChooseModel, providers]);

  const handleModelChange = useCallback(
    async (providerId: string, modelId: string) => {
      if (!providerId || !modelId || saving) return;
      const value = `${providerId}/${modelId}`;
      setSaving(true);
      try {
        // Scoped to this feature: fixing the walkthrough must not quietly
        // change the model used for commit messages and recaps.
        await updateDesktopSettings({ walkthroughModelOverride: value });
        onRetry();
      } catch (error) {
        console.warn('Failed to save small model override:', error);
      } finally {
        setSaving(false);
      }
    },
    [onRetry, saving]
  );

  // Offering a model the catalog already says cannot do this would just move
  // the same refusal one click later.
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
    if (reason === 'output-exhausted') {
      return label
        ? t('walkthrough.blocked.outputExhausted.description', { model: label })
        : t('walkthrough.blocked.outputExhausted.descriptionUnknownModel');
    }
    if (reason === 'structured-output-unsupported') {
      // Naming the model that was actually tried is the whole point of this
      // screen; the unnamed variant is a defensive fallback, not the norm.
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
            allowedProviderIds={providers}
            isModelAllowed={isStructuredOutputCapable}
          />
        </div>
      )}

      {(reason === 'empty-diff' || reason === 'only-generated') && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t('walkthrough.action.refresh')}
        </Button>
      )}
    </div>
  );
};
