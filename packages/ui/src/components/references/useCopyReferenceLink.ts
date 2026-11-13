import React from 'react';

import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';

/** Copies an issue's, change request's or tracker item's address; the toast confirms, as nothing on screen changes. */
export const useCopyReferenceLink = (): ((url: string) => void) => {
    const { t } = useI18n();
    return React.useCallback((url: string) => {
        void copyTextToClipboard(url).then((result) => {
            if (result.ok) toast.success(t('references.link.copied'));
            else toast.error(t('references.link.copyFailed'));
        });
    }, [t]);
};
