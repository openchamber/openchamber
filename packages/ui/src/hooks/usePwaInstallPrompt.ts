import React from 'react';
import { toast } from '@/components/ui';
import { isWebRuntime } from '@/lib/desktop';
import { usePwaDetection } from '@/hooks/usePwaDetection';

type InstallPromptOutcome = 'accepted' | 'dismissed';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: InstallPromptOutcome }>;
};

export const usePwaInstallPrompt = () => {
  const { browserTab } = usePwaDetection();

  React.useEffect(() => {
    if (typeof window === 'undefined' || !isWebRuntime() || !browserTab) {
      return;
    }

    let deferredPrompt: BeforeInstallPromptEvent | null = null;
    let installToastId: string | number | null = null;

    const dismissInstallToast = () => {
      if (installToastId === null) {
        return;
      }
      toast.dismiss(installToastId);
      installToastId = null;
    };

    const triggerInstall = async () => {
      if (!deferredPrompt) {
        return;
      }

      const promptEvent = deferredPrompt;
      deferredPrompt = null;
      dismissInstallToast();

      await promptEvent.prompt();
      const { outcome } = await promptEvent.userChoice;
      if (outcome === 'accepted') {
        toast.success('Install started');
      }
    };

    const onBeforeInstallPrompt = (event: Event) => {
      const installEvent = event as BeforeInstallPromptEvent;
      if (typeof installEvent.prompt !== 'function') {
        return;
      }

      installEvent.preventDefault();
      deferredPrompt = installEvent;

      if (installToastId !== null) {
        return;
      }

      installToastId = toast.info('Install OpenChamber for quicker access', {
        duration: Infinity,
        action: {
          label: 'Install',
          onClick: () => {
            void triggerInstall();
          },
        },
      });
    };

    const onAppInstalled = () => {
      deferredPrompt = null;
      dismissInstallToast();
      toast.success('OpenChamber installed');
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt as EventListener);
    window.addEventListener('appinstalled', onAppInstalled);

    return () => {
      dismissInstallToast();
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt as EventListener);
      window.removeEventListener('appinstalled', onAppInstalled);
    };
  }, [browserTab]);
};
