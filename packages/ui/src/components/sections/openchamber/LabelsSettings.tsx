import React from 'react';
import { useSessionLabelsStore, LABEL_COLOR_CSS_MAP } from '@/stores/useSessionLabelsStore';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export const LabelsSettings: React.FC = () => {
  const { t } = useI18n();
  const labels = useSessionLabelsStore((s) => s.labels);
  const renameLabel = useSessionLabelsStore((s) => s.renameLabel);
  const resetLabelName = useSessionLabelsStore((s) => s.resetLabelName);

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h3 className="typography-ui-header font-semibold text-foreground">
          {t('settings.labels.title')}
        </h3>
        <p className="typography-meta text-muted-foreground">
          {t('settings.labels.description')}
        </p>
      </div>
      <div className="space-y-2">
        {labels.map((label) => (
          <div key={label.id} className="flex items-center gap-3 rounded-md border border-border/40 px-3 py-2">
            <span
              className="h-4 w-4 shrink-0 rounded-full"
              style={{ backgroundColor: LABEL_COLOR_CSS_MAP[label.color] }}
            />
            <input
              type="text"
              value={label.name}
              onChange={(e) => renameLabel(label.id, e.target.value)}
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              placeholder={label.color}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => resetLabelName(label.id)}
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <Icon name="refresh" className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t('settings.labels.resetName')}</TooltipContent>
            </Tooltip>
          </div>
        ))}
      </div>
    </div>
  );
};
