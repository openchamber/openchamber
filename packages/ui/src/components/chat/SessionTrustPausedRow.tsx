import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useResumeOpenCodeFolder } from '@/components/projects/useOpenCodeTrustPause';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { formatDirectoryName } from '@/lib/utils';

export const SessionTrustPausedRow: React.FC<{ directory: string }> = React.memo(({ directory }) => {
    const { t } = useI18n();
    const resumeFolder = useResumeOpenCodeFolder();

    return (
        <div role="group" className="flex oc-composer-row min-w-0 items-center gap-2 border-b border-edge ps-3 pe-1.5">
            <Icon name="alert" className="size-3.5 shrink-0 text-status-warning" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={directory}>
                {t('chat.trustPaused.text', { name: formatDirectoryName(directory) })}
            </span>
            <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void resumeFolder(directory)}
                onMouseDown={(event) => event.preventDefault()}
                className="shrink-0 text-primary/80 hover:bg-transparent hover:text-primary"
            >
                {t('chat.trustPaused.action')}
            </Button>
        </div>
    );
});

SessionTrustPausedRow.displayName = 'SessionTrustPausedRow';
