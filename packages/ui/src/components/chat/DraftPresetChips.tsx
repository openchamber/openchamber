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
    onSubmit: (starter: ResolvedStarter) => void;
    className?: string;
};

const TRASH_DROPPABLE_ID = '__draft-starter-trash__';

const CHIP_ICON_BUTTON_CLASS =
    'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-transparent transition-colors';

const CHIP_CLASS =
    'group inline-flex h-6 touch-none select-none items-center gap-1.5 rounded-full px-2.5 typography-meta text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground';


const SortableChip: React.FC<{
    item: ResolvedStarter;
    onSubmit: (starter: ResolvedStarter) => void;
    onRemove: () => void;
    onToggleShared?: () => void;
    hideRemove?: boolean;
    overflowed?: boolean;
}> = ({ item, onSubmit, onRemove, onToggleShared, hideRemove, overflowed }) => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id, disabled: overflowed });
    const chipStyle: React.CSSProperties = {
        backgroundColor: currentTheme?.colors?.surface?.elevated,
        borderColor: currentTheme?.colors?.interactive?.border,
    };

    return (
        <div
            ref={setNodeRef}
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

const DraftPresetChipsContent: React.FC<DraftPresetChipsProps> = ({ onSubmit, className }) => {
    const { global, project, pinnable, ensureLoaded, addStarter, removeStarter, reorder, shareStarter, unshareStarter } = useDraftStarters();
    const { isMobile } = useDeviceInfo();
    const [isDragging, setIsDragging] = React.useState(false);
    const chipsRef = React.useRef<HTMLDivElement | null>(null);
    const [fitCount, setFitCount] = React.useState<number | null>(null);
    const starters = React.useMemo(() => [...global, ...project], [global, project]);

    React.useLayoutEffect(() => {
        const chipsRow = chipsRef.current;
        if (isMobile || !chipsRow) {
            setFitCount(null);
            return;
        }
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
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
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
        if (overChip && overChip.group === chip.group) {
            reorder(chip.group, activeId, overId);
        }
    };

    return (
        <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            onDragStart={handleDragStart}
            onDragCancel={handleDragCancel}
            onDragEnd={handleDragEnd}
        >
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

export const DraftPresetChips = React.memo(DraftPresetChipsView);
