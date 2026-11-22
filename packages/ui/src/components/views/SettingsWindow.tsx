import React from 'react';
import { Dialog } from '@base-ui/react/dialog';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { registerCloseTabTarget } from '@/lib/closeTabTarget';
import { SettingsView } from './SettingsView';

interface SettingsWindowProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const SettingsWindow: React.FC<SettingsWindowProps> = ({ open, onOpenChange }) => {
  const { t } = useI18n();
  const descriptionId = React.useId();
  const popupRef = React.useRef<HTMLDivElement>(null);
  const focusSettingsSearch = React.useCallback(() => {
    const popup = popupRef.current;
    return popup?.querySelector<HTMLElement>('[data-settings-search]') ?? popup ?? true;
  }, []);

  const hasOpenFloatingMenu = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return false;
    }

    return Boolean(
      document.querySelector('[data-slot="dropdown-menu-content"][data-open], [data-slot="select-content"][data-open]')
    );
  }, []);

  React.useEffect(() => {
    if (!open) return;
    return registerCloseTabTarget(() => {
      if (hasOpenFloatingMenu()) return;
      onOpenChange(false);
    }, popupRef, 1);
  }, [hasOpenFloatingMenu, onOpenChange, open]);

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
            'oc-glass-backdrop fixed inset-0 z-50 bg-surface-overlay/60',
            'transition-opacity duration-150 ease-out',
            'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0',
          )}
        />
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          <Dialog.Popup
            ref={popupRef}
            aria-describedby={descriptionId}
            initialFocus={focusSettingsSearch}
            className={cn(
              'relative pointer-events-auto outline-none',
              'w-[90vw] max-w-[1200px] h-[85vh] max-h-[900px]',
              'oc-window-corners oc-modal-shadow overflow-hidden origin-center',
              'bg-background',
              'transition-all duration-150 ease-out',
              'data-[starting-style]:opacity-0 data-[starting-style]:scale-[0.98]',
              'data-[ending-style]:opacity-0 data-[ending-style]:scale-[0.98]',
              'data-[nested-dialog-open]:brightness-[0.55] dark:data-[nested-dialog-open]:brightness-[0.4]',
            )}
          >
            <Dialog.Description id={descriptionId} className="sr-only">
              {t('settings.window.description')}
            </Dialog.Description>
            <SettingsView onClose={() => onOpenChange(false)} isWindowed />
          </Dialog.Popup>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
