import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { MoveSessionDialog } from '@/components/session/MoveSessionDialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { formatDirectoryName } from '@/lib/utils';
import { useIsSessionWorktreeMovePending } from '@/lib/worktrees/sessionWorktreeMove';

/**
 * A top row of the composer while the session's folder is gone: nothing can
 * run there, and moving the session is the way out. The move stays the user's
 * call, since only they know where the folder went.
 */
export const SessionFolderMissingRow: React.FC<{ sessionId: string; directory: string; busy: boolean }> = React.memo(({ sessionId, directory, busy }) => {
    const { t } = useI18n();
    const [dialogOpen, setDialogOpen] = React.useState(false);
    const moving = useIsSessionWorktreeMovePending(sessionId);

    return (
        <div role="group" className="flex oc-composer-row min-w-0 items-center gap-2 border-b border-edge ps-3 pe-1.5">
            <Icon name="alert" className="size-3.5 shrink-0 text-status-warning" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={directory}>
                {t('chat.folderMissing.text', { name: formatDirectoryName(directory) })}
            </span>
            <Tooltip>
                <TooltipTrigger asChild>
                    <span className="inline-flex shrink-0">
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={moving || busy}
                            onClick={() => setDialogOpen(true)}
                            onMouseDown={(event) => event.preventDefault()}
                            className="shrink-0 text-primary/80 hover:bg-transparent hover:text-primary"
                        >
                            {moving ? <Icon name="loader-4" className="size-3 animate-spin" aria-hidden="true" /> : null}
                            {t('chat.folderMissing.action')}
                        </Button>
                    </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{t(busy ? 'sessions.sidebar.session.moveToWorktree.tooltipBusy' : 'contextTooltips.chat.moveSession')}</TooltipContent>
            </Tooltip>
            {dialogOpen ? (
                <MoveSessionDialog open onOpenChange={setDialogOpen} sessionId={sessionId} sourceDirectory={directory} />
            ) : null}
        </div>
    );
});

SessionFolderMissingRow.displayName = 'SessionFolderMissingRow';
