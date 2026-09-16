import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useResolvedModel } from '@/stores/resolvedModelStore';

/** A provider prefix ("hosted_vllm/…") names the gateway, not the model. */
const getResolvedModelShortName = (model: string): string => {
  const slash = model.lastIndexOf('/');
  return slash === -1 ? model : model.slice(slash + 1);
};

/**
 * The backing model a proxied provider actually served for this session,
 * captured from gateway response headers. Renders nothing when the session has
 * no report: direct providers never carry the headers, so absence is correct
 * rather than an error.
 */
export const ResolvedModelBadge: React.FC<{ sessionId: string | null; className?: string }> = ({ sessionId, className }) => {
  const { t } = useI18n();
  const resolved = useResolvedModel(sessionId);
  if (!resolved) return null;
  const shortName = getResolvedModelShortName(resolved.model);

  return (
    <Tooltip delayDuration={600}>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'typography-micro text-muted-foreground truncate max-w-[160px] min-w-0',
            className,
          )}
          aria-label={t('chat.modelControls.resolvedModel.ariaLabel', { model: shortName })}
        >
          {shortName}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px]">
        <span className="typography-meta text-muted-foreground">
          {t('chat.modelControls.resolvedModel.tooltip')}
        </span>
      </TooltipContent>
    </Tooltip>
  );
};
