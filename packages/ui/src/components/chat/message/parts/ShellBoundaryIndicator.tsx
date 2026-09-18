import React from 'react';

import { useI18n } from '@/lib/i18n';
import type { ShellOperationBoundary } from './shellOperationBoundary';

const ShellBoundaryIndicator: React.FC<{ operation: ShellOperationBoundary }> = ({ operation }) => {
    const { t } = useI18n();
    const accessibleLabel = operation.initiator === 'user'
        ? t('chat.shellBoundary.userAria')
        : t('chat.shellBoundary.agentAria');

    return (
        <span
            className="inline-flex shrink-0 items-center whitespace-nowrap rounded bg-[var(--status-warning)]/10 px-1 py-0.5 typography-micro leading-none text-[var(--status-warning)]"
            aria-label={accessibleLabel}
            title={accessibleLabel}
        >
            {t('chat.shellBoundary.status')}
        </span>
    );
};

export default ShellBoundaryIndicator;
