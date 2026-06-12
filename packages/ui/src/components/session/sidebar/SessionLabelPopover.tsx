import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import {
  useSessionLabelsStore,
  LABEL_COLOR_CSS_MAP,
} from '@/stores/useSessionLabelsStore';

interface SessionLabelPopoverProps {
  sessionId: string;
  children: React.ReactElement;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const SessionLabelPopover = React.memo(function SessionLabelPopover({
  sessionId,
  children,
  open,
  onOpenChange,
}: SessionLabelPopoverProps) {
  const { t } = useI18n();
  const labels = useSessionLabelsStore((s) => s.labels);
  const sessionLabelMap = useSessionLabelsStore((s) => s.sessionLabelMap);
  const assignLabel = useSessionLabelsStore((s) => s.assignLabel);
  const removeLabel = useSessionLabelsStore((s) => s.removeLabel);

  const currentLabelId = sessionLabelMap[sessionId] ?? null;

  const handleLabelClick = (labelId: string) => {
    if (currentLabelId === labelId) {
      removeLabel(sessionId);
    } else {
      assignLabel(sessionId, labelId);
    }
    onOpenChange(false);
  };

  const handleRemove = () => {
    removeLabel(sessionId);
    onOpenChange(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger render={children} />
      <Popover.Portal>
        <Popover.Positioner sideOffset={4} align="start">
          <Popover.Popup className="z-50 min-w-[160px] rounded-lg border border-border bg-popover p-1.5 shadow-md">
            {labels.map((label) => {
              const isActive = currentLabelId === label.id;
              return (
                <button
                  key={label.id}
                  type="button"
                  onClick={() => handleLabelClick(label.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground transition-colors hover:bg-muted',
                    isActive && 'bg-muted/60',
                  )}
                >
                  <span
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: LABEL_COLOR_CSS_MAP[label.color] }}
                  />
                  <span className="flex-1 text-left">{label.name}</span>
                  {isActive && (
                    <Icon name="check-line" className="h-3.5 w-3.5 text-foreground" />
                  )}
                </button>
              );
            })}

            {currentLabelId && (
              <>
                <div className="my-1 border-t border-border/40" />
                <button
                  type="button"
                  onClick={handleRemove}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
                >
                  <Icon name="close-line" className="h-3.5 w-3.5" />
                  <span>{t('sidebar.labels.remove')}</span>
                </button>
              </>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});
