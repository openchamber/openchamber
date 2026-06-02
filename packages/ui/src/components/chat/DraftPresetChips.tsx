import React from 'react';
import {
    DndContext,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    closestCenter,
    type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import {
    Command,
    CommandInput,
    CommandList,
    CommandEmpty,
    CommandGroup,
    CommandItem,
} from '@/components/ui/command';
import {
    Dialog,
    DialogTrigger,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { cn } from '@/lib/utils';
import {
    useDraftStarters,
    type ResolvedStarter,
    type PinnableItem,
    type PinnableSection,
    type StarterGroup,
} from './useDraftStarters';

type DraftPresetChipsProps = {
    /** Called with the resolved text (command or skill invocation) when a chip is clicked. */
    onSubmit: (text: string) => void;
    /** Extra classes for the wrapper (e.g. width/spacing per surface). */
    className?: string;
};

const PICKER_SECTIONS: { key: PinnableSection; headingKey: 'chat.draftStarters.sectionBuiltIn' | 'chat.draftStarters.sectionCommands' | 'chat.draftStarters.sectionSkills' }[] = [
    { key: 'built-in', headingKey: 'chat.draftStarters.sectionBuiltIn' },
    { key: 'command', headingKey: 'chat.draftStarters.sectionCommands' },
    { key: 'skill', headingKey: 'chat.draftStarters.sectionSkills' },
];

const SortableChip: React.FC<{
    item: ResolvedStarter;
    onSubmit: (text: string) => void;
    onRemove: () => void;
}> = ({ item, onSubmit, onRemove }) => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
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
            className={cn('group/chip relative', isDragging && 'z-10 opacity-60')}
        >
            <button
                type="button"
                {...attributes}
                {...listeners}
                onClick={() => onSubmit(item.submitText)}
                className="group inline-flex touch-none select-none items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground"
                style={chipStyle}
            >
                <Icon name={item.icon} className="h-3.5 w-3.5 shrink-0 opacity-70 transition-opacity group-hover:opacity-100" />
                <span className="whitespace-nowrap">{item.label}</span>
            </button>
            <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onRemove(); }}
                aria-label={t('chat.draftStarters.remove')}
                title={t('chat.draftStarters.remove')}
                className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full border text-muted-foreground shadow-sm hover:text-foreground group-hover/chip:flex"
                style={chipStyle}
            >
                <Icon name="close" className="h-2.5 w-2.5" />
            </button>
        </div>
    );
};

const StarterGroupRow: React.FC<{
    group: StarterGroup;
    items: ResolvedStarter[];
    onSubmit: (text: string) => void;
    onRemove: (group: StarterGroup, ref: ResolvedStarter['ref']) => void;
    onReorder: (group: StarterGroup, fromId: string, toId: string) => void;
}> = ({ group, items, onSubmit, onRemove, onReorder }) => {
    const sensors = useSensors(
        // Desktop: start dragging after a small move so a click still submits.
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        // Touch: long-press to drag (tap submits, a quick swipe scrolls instead).
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    );
    const handleDragEnd = (event: DragEndEvent) => {
        const { active, over } = event;
        if (over && active.id !== over.id) {
            onReorder(group, String(active.id), String(over.id));
        }
    };
    return (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={items.map((i) => i.id)} strategy={rectSortingStrategy}>
                {items.map((item) => (
                    <SortableChip
                        key={item.id}
                        item={item}
                        onSubmit={onSubmit}
                        onRemove={() => onRemove(group, item.ref)}
                    />
                ))}
            </SortableContext>
        </DndContext>
    );
};

const StarterPickerList: React.FC<{
    pinnable: PinnableItem[];
    onPick: (item: PinnableItem) => void;
    className?: string;
}> = ({ pinnable, onPick, className }) => {
    const { t } = useI18n();
    return (
        <Command className={cn('min-h-0', className)}>
            <CommandInput placeholder={t('chat.draftStarters.searchPlaceholder')} />
            <CommandList>
                <CommandEmpty>{t('chat.draftStarters.empty')}</CommandEmpty>
                {PICKER_SECTIONS.map((section) => {
                    const list = pinnable.filter((item) => item.section === section.key);
                    if (list.length === 0) return null;
                    return (
                        <CommandGroup key={section.key} heading={t(section.headingKey)}>
                            {list.map((item) => (
                                <CommandItem
                                    key={`${item.type}:${item.name}`}
                                    value={`${item.section} ${item.label} ${item.name}`}
                                    onSelect={() => onPick(item)}
                                >
                                    {/* No per-row icon: the section heading already conveys the type. */}
                                    <span className="truncate">{item.label}</span>
                                </CommandItem>
                            ))}
                        </CommandGroup>
                    );
                })}
            </CommandList>
        </Command>
    );
};

const AddStarterPicker: React.FC<{
    pinnable: PinnableItem[];
    onOpen: () => void;
    onAdd: (item: PinnableItem) => void;
}> = ({ pinnable, onOpen, onAdd }) => {
    const { t } = useI18n();
    const { currentTheme } = useThemeSystem();
    const [open, setOpen] = React.useState(false);

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                setOpen(next);
                if (next) onOpen();
            }}
        >
            <DialogTrigger asChild>
                <button
                    type="button"
                    aria-label={t('chat.draftStarters.add')}
                    title={t('chat.draftStarters.add')}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-full border text-muted-foreground transition-colors hover:bg-[var(--interactive-hover)] hover:text-foreground"
                    style={{
                        backgroundColor: currentTheme?.colors?.surface?.elevated,
                        borderColor: currentTheme?.colors?.interactive?.border,
                    }}
                >
                    <Icon name="add" className="h-4 w-4" />
                </button>
            </DialogTrigger>
            <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-sm">
                <DialogHeader className="px-4 pb-2 pt-4 text-left">
                    <DialogTitle>{t('chat.draftStarters.add')}</DialogTitle>
                </DialogHeader>
                <StarterPickerList
                    pinnable={pinnable}
                    onPick={(item) => { onAdd(item); setOpen(false); }}
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
 */
export const DraftPresetChips: React.FC<DraftPresetChipsProps> = ({ onSubmit, className }) => {
    const { global, project, pinnable, ensureLoaded, addStarter, removeStarter, reorder } = useDraftStarters();

    return (
        <div className={cn('flex flex-wrap items-center justify-center gap-2', className)}>
            {global.length > 0 ? (
                <StarterGroupRow group="global" items={global} onSubmit={onSubmit} onRemove={removeStarter} onReorder={reorder} />
            ) : null}
            {project.length > 0 ? (
                <StarterGroupRow group="project" items={project} onSubmit={onSubmit} onRemove={removeStarter} onReorder={reorder} />
            ) : null}
            <AddStarterPicker pinnable={pinnable} onOpen={ensureLoaded} onAdd={addStarter} />
        </div>
    );
};
