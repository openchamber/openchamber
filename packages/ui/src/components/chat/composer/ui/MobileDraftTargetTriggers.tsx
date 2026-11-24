import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { DraftFolderTarget } from './DraftFolderTarget';
import { DraftKindToggle } from './DraftKindToggle';
import { MobileDraftsHerePicker } from './DraftsHerePicker';
import { ProjectLabel, type DraftTargetProps } from './DraftTargetSelectors';

export function MobileDraftTargetTriggers(
    props: Pick<DraftTargetProps, 'selectedProject' | 'selectedBranchLabel' | 'showBranchSelector' | 'theme'>
        & { onOpenPicker: (picker: 'project' | 'branch') => void },
) {
    const { t } = useI18n();
    const { selectedProject, selectedBranchLabel, showBranchSelector, theme, onOpenPicker } = props;
    return (
        <div className="mb-1.5 flex min-w-0 items-center gap-x-2 px-0.5">
            <button type="button" className="inline-flex h-7 min-w-0 max-w-[34vw] shrink-0 cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)]" onClick={() => onOpenPicker('project')}>
                {selectedProject.kind === 'chat'
                    ? <span className="truncate typography-ui-label">{t('chat.chatInput.chooseProject')}</span>
                    : <ProjectLabel project={selectedProject} theme={theme} />}
                <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            </button>
            {showBranchSelector ? (
                <button type="button" className="inline-flex h-7 min-w-0 max-w-[48vw] flex-shrink cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)]" onClick={() => onOpenPicker('branch')}>
                    <span className="truncate">{selectedBranchLabel ?? t('chat.chatInput.branch')}</span>
                    <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                </button>
            ) : null}
            <DraftFolderTarget />
            <div className="ms-auto flex shrink-0 items-center gap-1">
                <MobileDraftsHerePicker />
                <DraftKindToggle compact />
            </div>
        </div>
    );
}
