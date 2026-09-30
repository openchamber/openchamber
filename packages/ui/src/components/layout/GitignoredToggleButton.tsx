import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { setFilesViewShowGitignored, useFilesViewShowGitignored } from '@/lib/filesViewShowGitignored';
import { cn } from '@/lib/utils';

/**
 * Shows or hides gitignored files in a file tree header. The same setting as
 * Settings → Git, so every tree and the Settings row stay in step.
 */
export const GitignoredToggleButton: React.FC<{ className?: string }> = ({ className }) => {
    const { t } = useI18n();
    const showGitignored = useFilesViewShowGitignored();
    const label = showGitignored ? t('filesView.tree.actions.hideGitignored') : t('filesView.tree.actions.showGitignored');
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="inline-flex flex-shrink-0">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setFilesViewShowGitignored(!showGitignored)}
                        className={cn('p-0 flex-shrink-0', className)}
                        aria-pressed={showGitignored}
                        aria-label={label}
                    >
                        <Icon name={showGitignored ? 'eye' : 'eye-off'} className="size-4" />
                    </Button>
                </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
        </Tooltip>
    );
};
