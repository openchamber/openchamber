import React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
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
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-md"
        />
        <DialogPrimitive.Content
          aria-describedby={descriptionId}
          className={cn(
            'fixed z-50 top-[50%] left-[50%] translate-x-[-50%] translate-y-[-50%]',
            'w-[90vw] max-w-[960px] h-[85vh] max-h-[900px]',
            'rounded-xl border shadow-2xl overflow-hidden',
            'bg-background'
          )}
        >
          <DialogPrimitive.Description id={descriptionId} className="sr-only">
            OpenChamber settings window.
          </DialogPrimitive.Description>
          <SettingsView onClose={() => onOpenChange(false)} isWindowed />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
};
