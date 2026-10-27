import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

/** Account activation affects every session on the connected server. */
export const useAccountRotationNotice = (): void => {
  const { t } = useI18n();
  React.useEffect(() => subscribeOpenchamberEvents((event) => {
    if (event.type === 'account-rotated') {
      toast.info(t('settings.providers.accounts.toast.switched', { account: event.accountLabel }));
    }
  }), [t]);
};
