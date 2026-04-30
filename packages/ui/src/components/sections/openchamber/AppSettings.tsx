import React from 'react';
import { RiServerLine, RiExternalLinkLine } from '@remixicon/react';
import { useIsAndroidTwa } from '@/hooks/useIsAndroidTwa';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

export const AppSettings: React.FC = () => {
  const isAndroidTwa = useIsAndroidTwa();
  const [serverUrl, setServerUrl] = React.useState('');

  React.useEffect(() => {
    const bridge = window.AndroidNotificationBridge;
    if (bridge?.getServerUrl) {
      try {
        setServerUrl(bridge.getServerUrl());
      } catch {
        setServerUrl('');
      }
    }
  }, []);

  const handleOpenNativeSettings = React.useCallback(() => {
    const bridge = window.AndroidNotificationBridge;
    if (bridge?.openAppSettings) {
      bridge.openAppSettings();
    }
  }, []);

  if (!isAndroidTwa) {
    return null;
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2 px-2">
        <RiServerLine className="h-4 w-4 text-muted-foreground" />
        <h3 className="typography-ui-header font-medium text-foreground">Server Connection</h3>
      </div>

      <div className="space-y-3 px-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="typography-ui-label text-foreground">Server URL</span>
          <span className="typography-micro text-muted-foreground">
            The OpenCode server this app connects to. Change it to point to a different instance.
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={serverUrl}
            readOnly
            className="h-7 flex-1"
            aria-label="Current server URL"
          />
          <Button
            size="sm"
            type="button"
            variant="outline"
            onClick={handleOpenNativeSettings}
            className="h-7 gap-1"
          >
            Change
            <RiExternalLinkLine className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </section>
  );
};
