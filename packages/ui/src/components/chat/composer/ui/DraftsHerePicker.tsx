/**
 * The other drafts waiting in the folder a new session is about to start in,
 * as a control at the end of the draft's project and branch row. Every way
 * into a new session opens a fresh, empty draft, and this is where the user
 * finds what they left there. A control in a row that is already there takes
 * no height and lines up with its neighbours; a list on the draft screen sat
 * between the title and the composer at a width matching neither. A new Chat
 * keeps one draft in its composer and has none stored, so it shows nothing.
 */

import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { formatSessionCompactDateLabel } from '@/components/session/sidebar/utils';
import { useSessionDraftRow } from '@/components/session/sidebar/works/useSessionDraftRow';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useSessionDraftsStore, type SessionDraft } from '@/stores/useSessionDraftsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

const NO_DRAFTS: readonly SessionDraft[] = [];
const noop = (): void => undefined;

/** The stored drafts of the open draft's exact folder, newest first, without the open one. */
function useDraftsHere(): readonly SessionDraft[] {
    const directory = useSessionUIStore((state) => (
        !state.currentSessionId && state.newSessionDraft.open && state.newSessionDraft.target === 'project'
            ? normalizePath(state.newSessionDraft.directoryOverride ?? null)
            : null
    ));
    const openDraftId = useSessionUIStore((state) => state.newSessionDraft.workDraftId);
    const storedDrafts = useSessionDraftsStore((state) => (state.runtimeKey === getRuntimeKey() ? state.drafts : NO_DRAFTS));
    return React.useMemo(() => (directory
        ? storedDrafts
            .filter((draft) => draft.id !== openDraftId && normalizePath(draft.directory) === directory)
            .sort((left, right) => right.updatedAt - left.updatedAt)
        : NO_DRAFTS), [directory, openDraftId, storedDrafts]);
}

function useCountLabel(count: number): string {
    const { t } = useI18n();
    return count === 1
        ? t('chat.draftTarget.drafts.triggerSingle', { count })
        : t('chat.draftTarget.drafts.triggerPlural', { count });
}

const DraftTime: React.FC<{ draft: SessionDraft }> = ({ draft }) => (
    <span className="shrink-0 typography-micro text-muted-foreground">{formatSessionCompactDateLabel(draft.updatedAt)}</span>
);

// The time and, on the highlighted entry, the cross share one slot, as a
// session row's time and its hover actions do. The hidden time is invisible
// rather than transparent: an opacity below 1 paints it above the cross, where
// it took the click and opened the draft.
const DraftMenuItem: React.FC<{ draft: SessionDraft }> = ({ draft }) => {
    const { t } = useI18n();
    const { label, open, discard } = useSessionDraftRow(draft, noop);
    return (
        <DropdownMenuItem onClick={open} className="group/draft gap-2">
            <span dir="auto" className="oc-ui-start-align min-w-0 flex-1 truncate italic">{label}</span>
            <span className="grid shrink-0 place-items-end [&>*]:[grid-area:1/1]">
                <span className="group-data-[highlighted]/draft:invisible"><DraftTime draft={draft} /></span>
                <button
                    type="button"
                    aria-label={t('sessions.sidebar.draft.discard')}
                    // The entry keeps the menu open and the draft closed: the
                    // click stops here before the item's own handlers.
                    onClick={(event) => {
                        event.stopPropagation();
                        discard();
                    }}
                    className="pointer-events-none inline-flex size-4 items-center justify-center self-center rounded-md text-muted-foreground opacity-0 hover:text-foreground group-data-[highlighted]/draft:pointer-events-auto group-data-[highlighted]/draft:opacity-100"
                >
                    <Icon name="close" className="size-3" />
                </button>
            </span>
        </DropdownMenuItem>
    );
};

const DraftsHerePickerView: React.FC = () => {
    const { t } = useI18n();
    const drafts = useDraftsHere();
    const countLabel = useCountLabel(drafts.length);
    if (drafts.length === 0) return null;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="ms-auto h-7 w-fit shrink-0 gap-1 px-1.5 normal-case hover:bg-transparent data-[popup-open]:bg-transparent"
                >
                    <Icon name="edit" className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="typography-ui-label">{countLabel}</span>
                    <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-50" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" constrainToMain className="max-h-80 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto">
                <DropdownMenuLabel>{t('chat.draftTarget.drafts.heading')}</DropdownMenuLabel>
                {drafts.map((draft) => <DraftMenuItem key={draft.id} draft={draft} />)}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

/** Memoized: the composer re-renders on every keystroke. */
export const DraftsHerePicker = React.memo(DraftsHerePickerView);

const DraftSheetRow: React.FC<{ draft: SessionDraft; onClose: () => void }> = ({ draft, onClose }) => {
    const { label, open } = useSessionDraftRow(draft, onClose);
    return (
        <button
            type="button"
            className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-2.5 text-start typography-ui-label hover:bg-[var(--interactive-hover)]"
            onClick={open}
        >
            <span dir="auto" className="oc-ui-start-align min-w-0 flex-1 truncate italic">{label}</span>
            <DraftTime draft={draft} />
        </button>
    );
};

/** Phone: the same control in the draft's trigger row, opening a bottom sheet as its neighbours do. */
const MobileDraftsHerePickerView: React.FC = () => {
    const { t } = useI18n();
    const drafts = useDraftsHere();
    const countLabel = useCountLabel(drafts.length);
    const [open, setOpen] = React.useState(false);
    const close = React.useCallback(() => setOpen(false), []);
    if (drafts.length === 0) return null;

    return (
        <>
            <button
                type="button"
                className="ms-auto inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-1.5 typography-micro font-medium text-foreground/80 hover:bg-[var(--interactive-hover)]"
                onClick={() => setOpen(true)}
            >
                <Icon name="edit" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span>{countLabel}</span>
                <Icon name="arrow-down-s" className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            </button>
            <MobileOverlayPanel open={open} title={t('chat.draftTarget.drafts.heading')} onClose={close}>
                <div className="flex flex-col px-3 pb-4 pt-1">
                    {drafts.map((draft) => <DraftSheetRow key={draft.id} draft={draft} onClose={close} />)}
                </div>
            </MobileOverlayPanel>
        </>
    );
};

export const MobileDraftsHerePicker = React.memo(MobileDraftsHerePickerView);
