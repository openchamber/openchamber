import React from 'react';

import { cn } from '@/lib/utils';
import { useSessionLabelsStore, LABEL_COLOR_CSS_MAP } from '@/stores/useSessionLabelsStore';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';

export function LabelFilter() {
  const { t } = useI18n();
  const labels = useSessionLabelsStore((s) => s.labels);
  const sessionLabelMap = useSessionLabelsStore((s) => s.sessionLabelMap);
  const activeFilterLabelIds = useSessionLabelsStore((s) => s.activeFilterLabelIds);
  const toggleFilter = useSessionLabelsStore((s) => s.toggleFilter);
  const clearFilters = useSessionLabelsStore((s) => s.clearFilters);

  const usedLabelIds = React.useMemo(() => {
    const used = new Set<string>();
    for (const labelId of Object.values(sessionLabelMap)) {
      used.add(labelId);
    }
    return used;
  }, [sessionLabelMap]);

  const visibleLabels = React.useMemo(
    () => labels.filter((l) => usedLabelIds.has(l.id)),
    [labels, usedLabelIds],
  );

  if (visibleLabels.length === 0) return null;

  const hasActiveFilters = activeFilterLabelIds.size > 0;

  return (
    <div className="flex items-center gap-1 px-2 pb-1">
      {visibleLabels.map((label) => {
        const isActive = activeFilterLabelIds.has(label.id);
        return (
          <Tooltip key={label.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => toggleFilter(label.id)}
                className={cn(
                  'h-3 w-3 rounded-full transition-all',
                  isActive
                    ? 'ring-2 ring-primary/50 ring-offset-1 ring-offset-background scale-110'
                    : 'opacity-60 hover:opacity-100',
                )}
                style={{ backgroundColor: LABEL_COLOR_CSS_MAP[label.color] }}
              />
            </TooltipTrigger>
            <TooltipContent side="bottom">{label.name}</TooltipContent>
          </Tooltip>
        );
      })}
      {hasActiveFilters && (
        <button
          type="button"
          onClick={clearFilters}
          className="ml-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {t('sidebar.labels.filter.clear')}
        </button>
      )}
    </div>
  );
}
