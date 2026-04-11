import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { RiCloseLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { MultiRunLauncher } from '@/components/multirun';

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

  const hasOpenFloatingMenu = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return false;
    }

    return Boolean(
      document.querySelector('[data-slot="dropdown-menu-content"][data-state="open"], [data-slot="select-content"][data-state="open"]')
    );
  }, []);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/50 dark:bg-black/75"
        />
        <DialogPrimitive.Content
          aria-describedby={descriptionId}
          onInteractOutside={(event) => {
            if (hasOpenFloatingMenu()) {
              event.preventDefault();
            }
          }}
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
              aria-label="Close multi-run"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md p-0.5 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <RiCloseLine className="h-5 w-5" />
            </button>
          </div>
          <DialogPrimitive.Description id={descriptionId} className="sr-only">
            OpenChamber Multi-Run window.
          </DialogPrimitive.Description>
          <MultiRunLauncher
            initialPrompt={initialPrompt}
            onCreated={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
            isWindowed
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};
