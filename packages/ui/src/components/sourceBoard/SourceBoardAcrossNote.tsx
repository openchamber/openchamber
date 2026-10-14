import * as React from 'react';

import type { AcrossExclusion, AcrossExclusionReason } from '@/components/references/acrossRepositories';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n, type I18nKey } from '@/lib/i18n';

import { repositoryLabel } from './boardRepository';

const REASON_KEYS = {
    gitlab: 'sourceBoard.across.reason.gitlab',
    missing: 'sourceBoard.across.reason.noRepo',
    'no-repo': 'sourceBoard.across.reason.noRepo',
    disconnected: 'sourceBoard.across.reason.disconnected',
    'invalid-context': 'sourceBoard.across.reason.invalidAccount',
    error: 'sourceBoard.across.reason.error',
} as const satisfies Record<AcrossExclusionReason, I18nKey>;

/**
 * Above a list across repositories: how many repositories it leaves out, and
 * in a menu which ones and why, so a list that looks complete never hides a gap.
 */
export const SourceBoardAcrossNote: React.FC<{ leftOut: readonly AcrossExclusion[]; root: string }> = ({ leftOut, root }) => {
    const { t } = useI18n();
    if (leftOut.length === 0) return null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="xs" variant="ghost" className="mx-1.5 mt-1 w-fit text-muted-foreground">
                    {leftOut.length === 1 ? t('sourceBoard.across.note.one') : t('sourceBoard.across.note.other', { count: leftOut.length })}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-72">
                <DropdownMenuLabel>{t('sourceBoard.across.note.label')}</DropdownMenuLabel>
                {leftOut.map(({ directory, reason }) => (
                    <div key={directory} className="flex flex-col px-2 py-1.5">
                        <span className="truncate typography-ui-label">{repositoryLabel(directory, root)}</span>
                        <span className="typography-micro text-muted-foreground">{t(REASON_KEYS[reason])}</span>
                    </div>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
