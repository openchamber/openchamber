import React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { cn } from '@/lib/utils';
import { MultiRunLauncher } from '@/components/multirun';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';

interface MultiRunWindowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialPrompt?: string;
}

export const MultiRunWindow: React.FC<MultiRunWindowProps> = ({
  open,
  onOpenChange,
  initialPrompt,
}) => {
  const descriptionId = React.useId();
  const { t } = useI18n();

  const hasOpenFloatingMenu = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return false;
    }

    return Boolean(
      document.querySelector('[data-slot="dropdown-menu-content"][data-open], [data-slot="select-content"][data-open]')
    );
  }, []);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && hasOpenFloatingMenu()) return;
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            'fixed inset-0 z-50 bg-black/50 dark:bg-black/75',
            'transition-opacity duration-150 ease-out',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
          )}
        />
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <Dialog.Popup
            aria-describedby={descriptionId}
            className={cn(
              'relative pointer-events-auto',
              'w-[90vw] max-w-[720px] h-[680px] max-h-[85vh]',
              'flex flex-col rounded-xl border shadow-none overflow-hidden origin-center',
              'bg-background',
              'transition-all duration-150 ease-out',
              'data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98]',
              'data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98]',
            )}
          >
            <div className="absolute right-0.5 top-0.5 z-50">
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                aria-label={t('multiRun.window.actions.closeAria')}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <Icon name="close" className="h-5 w-5" />
              </button>
            </div>
            <Dialog.Description id={descriptionId} className="sr-only">
              {t('multiRun.window.description')}
            </Dialog.Description>
            <MultiRunLauncher
              initialPrompt={initialPrompt}
              onCreated={() => onOpenChange(false)}
              onCancel={() => onOpenChange(false)}
              isWindowed
            />
          </Dialog.Popup>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
