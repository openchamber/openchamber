import React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { RiCloseLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { MultiRunLauncher } from '@/components/multirun';
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
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50 dark:bg-black/75" />
        <Dialog.Popup
          aria-describedby={descriptionId}
          className={cn(
            'fixed z-50 top-[50%] left-[50%] translate-x-[-50%] translate-y-[-50%]',
            'w-[90vw] max-w-[720px] h-[680px] max-h-[85vh]',
            'flex flex-col rounded-xl border shadow-none overflow-hidden',
            'bg-background'
          )}
        >
          <div className="absolute right-0.5 top-0.5 z-50">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label={t('multiRun.window.actions.closeAria')}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RiCloseLine className="h-5 w-5" />
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
      </Dialog.Portal>
    </Dialog.Root>
  );
};
