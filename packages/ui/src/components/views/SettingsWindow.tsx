import React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { cn } from '@/lib/utils';
import { SettingsView } from './SettingsView';

interface SettingsWindowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Settings rendered as a centered window with blurred backdrop.
 * Used for desktop and web (non-mobile) environments.
 */
export const SettingsWindow: React.FC<SettingsWindowProps> = ({ open, onOpenChange }) => {
  const descriptionId = React.useId();

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
            'w-[90vw] max-w-[960px] h-[85vh] max-h-[900px]',
            'rounded-xl border shadow-none overflow-hidden',
            'bg-background'
          )}
        >
          <Dialog.Description id={descriptionId} className="sr-only">
            OpenChamber settings window.
          </Dialog.Description>
          <SettingsView onClose={() => onOpenChange(false)} isWindowed />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
