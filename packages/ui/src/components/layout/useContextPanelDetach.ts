import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { detachContextPanel } from '@/lib/contextWindow/owner';
import { isContextWindow } from '@/lib/contextWindow/role';

export const useContextPanelDetach = () => {
  const { t } = useI18n();
  const isMobile = useUIStore((state) => state.isMobile);
  const available = !isContextWindow() && !isMobile && 'BroadcastChannel' in globalThis;
  const detach = React.useCallback(() => {
    void detachContextPanel().then((result) => {
      if (result === 'blocked') toast.error(t('contextPanel.window.blocked'));
      if (result === 'failed') toast.error(t('contextPanel.window.failed'));
    });
  }, [t]);
  return { available, detach };
};
