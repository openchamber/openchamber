import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { REFERENCE_META_TEXT } from './referencePickerItems';

export const PreviewRefreshButton: React.FC<{ onRefresh: () => Promise<void>; className?: string }> = ({ onRefresh, className }) => {
    const { t } = useI18n();
    const [refreshing, setRefreshing] = React.useState(false);
    const refresh = () => {
        setRefreshing(true);
        void onRefresh().finally(() => setRefreshing(false));
    };
    return (
        <ButtonTooltip label={t('references.picker.preview.refresh')} side="bottom" className={cn('shrink-0', className)}>
            <button
                type="button"
                className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none', REFERENCE_META_TEXT)}
                aria-label={t('references.picker.preview.refresh')}
                disabled={refreshing}
                onClick={refresh}
            >
                <Icon name="refresh" className={cn('size-3.5', refreshing && 'animate-spin')} />
            </button>
        </ButtonTooltip>
    );
};
