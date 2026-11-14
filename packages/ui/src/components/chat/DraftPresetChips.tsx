import React from 'react';
import {
    DndContext,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    useDroppable,
    closestCenter,
    MeasuringStrategy,
    type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import {
    Dialog,
    DialogTrigger,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { countFittingStarters, moveToFrontTarget } from './draftStarterFit';
import { useUIStore } from '@/stores/useUIStore';
import {
    useDraftStarters,
    type ResolvedStarter,
    type PinnableItem,
} from './useDraftStarters';
import { StarterPickerList, type OverflowActions } from './DraftStarterPickerList';

type DraftPresetChipsProps = {
    /** Called with the resolved starter invocation when a chip is clicked. */
    onSubmit: (starter: ResolvedStarter) => void;
    /** Extra classes for the wrapper (e.g. width/spacing per surface). */
    className?: string;
};

// Droppable id for the mobile "drag a chip here to delete" target. Kept distinct
// from any chip id (which are `group:type:name`) so collisions never alias.
const TRASH_DROPPABLE_ID = '__draft-starter-trash__';

// Shared box for the icon buttons in the "+" slot (add picker and the
// mobile trash drop-zone). Identical so swapping one for the other never shifts
// layout or changes the button size. shrink-0 keeps it from being compressed by
// the flex row. The border is transparent at rest and only the trash target
// colours it, so the box is the same in every state.
const CHIP_ICON_BUTTON_CLASS =
    'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-transparent transition-colors';

// A starter at rest is a quiet word on the page: flat and muted, with a fill
// only under the pointer. It is a suggestion, not the loudest control on the
// draft screen.
const CHIP_CLASS =
    'group inline-flex h-6 touch-none select-none items-center gap-1.5 rounded-full px-2.5 typography-meta text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground';


const SortableChip: React.FC<{
    item: ResolvedStarter;
    onSubmit: (starter: ResolvedStarter) => void;
    onRemove: () => void;
    /** Project chips only: move the starter into the team's shared file, or back out of it. */
    onToggleShared?: () => void;
    /** Hide the per-chip hover "x" (mobile uses the trash drop-zone instead). */
    hideRemove?: boolean;
    /** Past the end of the row: kept out of flow and out of reach, but measured. */
    overflowed?: boolean;
}> = ({ item, onSubmit, onRemove, onToggleShared, hideRemove, overflowed }) => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    // A chip past the end of the row is no drag source and no drop target:
    // its hidden box overlaps the visible row, and closestCenter would pick it.
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: overflowed });
    const chipStyle: React.CSSProperties = {
        backgroundColor: currentTheme?.colors?.surface?.elevated,
        borderColor: currentTheme?.colors?.interactive?.border,
    };

    return (
        <div
            ref={setNodeRef}
            // Translate only (no scaleX/scaleY) so the lifted chip keeps its own
            // width instead of stretching to the target slot.
            style={{ transform: CSS.Translate.toString(transform), transition }}
            className={cn('group/chip relative', isDragging && 'z-10 opacity-60', overflowed && 'invisible absolute')}
            data-starter-chip=""
            inert={overflowed}
        >
            <Tooltip disabled={!item.shared}>
                <TooltipTrigger asChild>
                    <button
                        type="button"
                        {...attributes}
                        {...listeners}
                        onClick={() => onSubmit(item)}
                        className={CHIP_CLASS}
                    >
                        {/* 16px beside the meta-size label, the composer footer's ratio. */}
                        <Icon name={item.icon} className="size-4 shrink-0" />
                        <span className="whitespace-nowrap">{item.label}</span>
                    </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{t('chat.draftStarters.sharedTitle')}</TooltipContent>
            </Tooltip>
            {onToggleShared && !hideRemove ? (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onToggleShared(); }}
                            aria-label={t(item.shared ? 'chat.draftStarters.makePersonal' : 'chat.draftStarters.share')}
                            className="absolute -inset-s-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full border text-muted-foreground shadow-sm hover:text-foreground group-hover/chip:flex"
                            style={chipStyle}
                        >
                            <Icon name={item.shared ? 'user' : 'team'} className="h-2.5 w-2.5" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>{t(item.shared ? 'chat.draftStarters.makePersonal' : 'chat.draftStarters.share')}</TooltipContent>
                </Tooltip>
            ) : null}
            {/* A shared starter is the team's: it leaves only through the repo file. */}
            {hideRemove || item.shared ? null : (
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); onRemove(); }}
                            aria-label={t('chat.draftStarters.remove')}
                            className="absolute -inset-e-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full border text-muted-foreground shadow-sm hover:text-foreground group-hover/chip:flex"
                            style={chipStyle}
                        >
                            <Icon name="close" className="h-2.5 w-2.5" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>{t('chat.draftStarters.remove')}</TooltipContent>
                </Tooltip>
            )}
        </div>
    );
};

const StarterGroup: React.FC<{
    items: ResolvedStarter[];
    onSubmit: (starter: ResolvedStarter) => void;
    onRemove: (item: ResolvedStarter) => void;
    onToggleShared?: (item: ResolvedStarter) => void;
    hideRemove?: boolean;
    overflowedIds: ReadonlySet<string>;
}> = ({ items, onSubmit, onRemove, onToggleShared, hideRemove, overflowedIds }) => (
    // Only the chips in the row take part in sorting.
    <SortableContext items={items.filter((i) => !overflowedIds.has(i.id)).map((i) => i.id)} strategy={rectSortingStrategy}>
        {items.map((item) => (
            <SortableChip
                key={item.id}
                item={item}
                onSubmit={onSubmit}
                onRemove={() => onRemove(item)}
                onToggleShared={onToggleShared ? () => onToggleShared(item) : undefined}
                hideRemove={hideRemove}
                overflowed={overflowedIds.has(item.id)}
            />
        ))}
    </SortableContext>
);

/**
 * Mobile delete target. Sits in the "+" slot and is only mounted while a chip is
 * being dragged; dropping a chip on it removes that starter. Styled to match the
 * add ("+") button so the swap reads as the same affordance toggling purpose.
 */
const TrashDropZone: React.FC = () => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const { setNodeRef, isOver } = useDroppable({ id: TRASH_DROPPABLE_ID });

    return (
        <button
            type="button"
            ref={setNodeRef}
            aria-label={t('chat.draftStarters.remove')}
            title={t('chat.draftStarters.remove')}
            // Same box as the "+" button so the swap never shifts layout; on-hover
            // feedback is color-only (no resize).
            className={cn(
                CHIP_ICON_BUTTON_CLASS,
                isOver ? 'border-destructive text-destructive' : 'text-muted-foreground',
            )}
            style={{
                backgroundColor: currentTheme?.colors?.surface?.elevated,
                borderColor: isOver ? undefined : currentTheme?.colors?.interactive?.border,
            }}
        >
            <Icon name="delete-bin" className="h-3.5 w-3.5" />
        </button>
    );
};

const AddStarterPicker: React.FC<{
    pinnable: PinnableItem[];
    onOpen: () => void;
    onAdd: (item: PinnableItem) => void;
    overflow: ResolvedStarter[];
    actions: OverflowActions;
}> = ({ pinnable, onOpen, onAdd, overflow, actions }) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (next) onOpen();
            }}
        >
            <Tooltip>
                <TooltipTrigger asChild>
                    <DialogTrigger asChild>
                        <button
                            type="button"
                            aria-label={t('chat.draftStarters.add')}
                            // A starter's own box, so it reads as one more chip of the row.
                            className={CHIP_CLASS}
                        >
                            <Icon name="add" className="size-4 shrink-0" />
                        </button>
                    </DialogTrigger>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{t('chat.draftStarters.add')}</TooltipContent>
            </Tooltip>
            <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-sm">
                <DialogHeader className="px-4 pb-2 pt-4 text-start">
                    <DialogTitle>{t('chat.draftStarters.add')}</DialogTitle>
                </DialogHeader>
                <StarterPickerList
                    pinnable={pinnable}
                    onPick={(item) => { onAdd(item); setOpen(false); }}
                    overflow={overflow}
                    actions={{ ...actions, onRun: (starter) => { setOpen(false); actions.onRun(starter); } }}
                    className="flex max-h-[60vh] flex-col"
                />
            </DialogContent>
        </Dialog>
    );
};

/**
 * The editable row of starter chips on the draft welcome screen. Shows the
 * global group then the project group (each reorderable within itself), plus a
 * "+" picker to pin existing commands/skills. The surface owns how a chip click
 * is submitted via `onSubmit`.
 *
 * Both groups share a single DndContext so the mobile trash drop-zone (which
 * replaces the "+" while dragging) is reachable from either group's drag.
 * Reorder is constrained to within a chip's own group; cross-group hovers are
 * ignored.
 */
const DraftPresetChipsContent: React.FC<DraftPresetChipsProps> = ({ onSubmit, className }) => {
    const { global, project, pinnable, ensureLoaded, addStarter, removeStarter, reorder, shareStarter, unshareStarter } = useDraftStarters();
    const { isMobile } = useDeviceInfo();
    const [isDragging, setIsDragging] = React.useState(false);
    const chipsRef = React.useRef<HTMLDivElement | null>(null);
    // How many starters fit one row before the "+"; null while all of them do.
    const [fitCount, setFitCount] = React.useState<number | null>(null);
    const starters = React.useMemo(() => [...global, ...project], [global, project]);

    // On the desktop the starters keep to one row; the rest wait behind the
    // "+", which lists them above the picker. Every chip stays mounted so its
    // width can be measured: the ones past the row sit out of flow, unseen.
    // The phone keeps its wrapping rows, where a chip is dragged to reorder.
    React.useLayoutEffect(() => {
        const chipsRow = chipsRef.current;
        if (isMobile || !chipsRow) {
            setFitCount(null);
            return;
        }
        // The room is the chip row's own width, which the layout below keeps
        // at what the container allows whichever chips are shown; a row as
        // wide as its chips shrank each time one hid and hid the next.
        const measure = () => {
            const chips = Array.from(chipsRow.querySelectorAll<HTMLElement>('[data-starter-chip]'));
            const add = chipsRow.querySelector<HTMLElement>('[data-starter-add]');
            const gap = Number.parseFloat(getComputedStyle(chipsRow).columnGap) || 0;
            setFitCount(countFittingStarters(
                chips.map((chip) => chip.getBoundingClientRect().width),
                chipsRow.getBoundingClientRect().width,
                gap,
                add ? add.getBoundingClientRect().width : 0,
            ));
        };
        measure();
        // The chip row is the width read above: it follows the caller's box
        // (the composer column narrows and widens with the wide-chat setting
        // while the full-width wrapper stays put). The chips too: a label
        // changes width when its font arrives.
        const observer = new ResizeObserver(measure);
        observer.observe(chipsRow);
        for (const chip of chipsRow.querySelectorAll('[data-starter-chip]')) observer.observe(chip);
        return () => observer.disconnect();
    }, [isMobile, starters]);

    const overflow = fitCount === null ? [] : starters.slice(fitCount);
    const overflowedIds = new Set(overflow.map((item) => item.id));
    const overflowActions: OverflowActions = {
        onRun: onSubmit,
        onRemove: (starter) => removeStarter(starter.group, starter.ref),
        onToggleShared: (starter) => (starter.shared ? unshareStarter(starter.ref) : shareStarter(starter.ref)),
        moveToFrontTarget: (starter) => moveToFrontTarget(starter, starter.group === 'project' ? project : global),
        onMoveToFront: (starter, targetId) => reorder(starter.group, starter.id, targetId),
    };

    const sensors = useSensors(
        // Desktop: start dragging after a small move so a click still submits.
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        // Touch: long-press to drag (tap submits, a quick swipe scrolls instead).
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    );

    const chipById = React.useCallback(
        (id: string): ResolvedStarter | undefined =>
            global.find((i) => i.id === id) ?? project.find((i) => i.id === id),
        [global, project],
    );

    const handleDragStart = () => setIsDragging(true);
    const handleDragCancel = () => setIsDragging(false);
    const handleDragEnd = (event: DragEndEvent) => {
        setIsDragging(false);
        const { active, over } = event;
        if (!over) return;
        const activeId = String(active.id);
        const chip = chipById(activeId);
        if (!chip) return;
        if (String(over.id) === TRASH_DROPPABLE_ID) {
            removeStarter(chip.group, chip.ref);
            return;
        }
        const overId = String(over.id);
        if (activeId === overId) return;
        const overChip = chipById(overId);
        // Reorder only within the same group; ignore cross-group hovers.
        if (overChip && overChip.group === chip.group) {
            reorder(chip.group, activeId, overId);
        }
    };

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            // The trash drop-zone mounts on drag start, so re-measure droppables
            // while dragging or it never registers a rect to drop onto.
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            onDragStart={handleDragStart}
            onDragCancel={handleDragCancel}
            onDragEnd={handleDragEnd}
        >
            {/* A full-width block around a centred one: the caller's box (a max
                width, or the composer column) takes its width from the
                container rather than from its chips, so the room measured
                above stays put as chips hide and show. As a flex item of a
                centred column it would shrink to its chips instead. */}
            <div className="w-full min-w-0">
                <div className={cn('mx-auto', className)}>
                <div ref={chipsRef} className={cn('relative flex w-full items-center justify-center gap-1.5', isMobile ? 'flex-wrap' : 'flex-nowrap')}>
                {global.length > 0 ? (
                    <StarterGroup
                        items={global}
                        onSubmit={onSubmit}
                        onRemove={(item) => removeStarter('global', item.ref)}
                        hideRemove={isMobile}
                        overflowedIds={overflowedIds}
                    />
                ) : null}
                {project.length > 0 ? (
                    <StarterGroup
                        items={project}
                        onSubmit={onSubmit}
                        onRemove={(item) => removeStarter('project', item.ref)}
                        onToggleShared={(item) => (item.shared ? unshareStarter(item.ref) : shareStarter(item.ref))}
                        hideRemove={isMobile}
                        overflowedIds={overflowedIds}
                    />
                ) : null}
                {isMobile && isDragging ? (
                    <TrashDropZone />
                ) : (
                    <span data-starter-add="" className="inline-flex shrink-0">
                        <AddStarterPicker pinnable={pinnable} onOpen={ensureLoaded} onAdd={addStarter} overflow={overflow} actions={overflowActions} />
                    </span>
                )}
                </div>
                </div>
            </div>
        </DndContext>
    );
};

const DraftPresetChipsView: React.FC<DraftPresetChipsProps> = (props) => {
    const visible = useUIStore((state) => state.draftStartersVisible);
    return visible ? <DraftPresetChipsContent {...props} /> : null;
};

/** Memoized: the composer re-renders on every keystroke, and nothing here depends on the draft text. */
export const DraftPresetChips = React.memo(DraftPresetChipsView);
