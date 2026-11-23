import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { getDraftTargetFolder } from '@/sync/draft-folder-target';
import { useSessionUIStore } from '@/sync/session-ui-store';

export function DraftFolderTarget() {
    const { t } = useI18n();
    const draft = useSessionUIStore((state) => state.newSessionDraft);
    const folderName = useSessionFoldersStore((state) => getDraftTargetFolder(state.foldersMap, draft)?.folder.name);
    if (!draft.open || !folderName) return null;
    const label = t('sessions.sidebar.folderItem.draftDestination', { folderName });
    return (
        <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground typography-micro" title={label}>
            <Icon name="folder" className="size-3.5 shrink-0" />
            <span className="truncate">{label}</span>
        </span>
    );
}
