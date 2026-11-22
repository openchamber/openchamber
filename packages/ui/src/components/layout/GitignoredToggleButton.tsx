import React from 'react';

import { ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { useI18n } from '@/lib/i18n';
import { setFilesViewShowGitignored, useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';

export const GitignoredToggleButton: React.FC<{ className?: string; iconClassName?: string }> = ({ className, iconClassName }) => {
    const { t } = useI18n();
    const showGitignored = useFilesViewShowGitignored();
    return (
        <ToolbarTooltipButton
            label={t('filesView.tree.actions.showGitignored')}
            icon="file-forbid"
            pressed={showGitignored}
            className={className}
            iconClassName={iconClassName}
            onClick={() => setFilesViewShowGitignored(!showGitignored)}
        />
    );
};
