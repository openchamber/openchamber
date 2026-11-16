import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import {
    Command,
    CommandInput,
    CommandList,
    CommandEmpty,
    CommandGroup,
    CommandItem,
} from '@/components/ui/command';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { PinnableItem, PinnableSection, ResolvedStarter } from './useDraftStarters';

// The list in the draft starters' "+" dialog: the starters that did not fit
// the row, each with its management, then what can be pinned.

const PICKER_SECTIONS: { key: PinnableSection; headingKey: 'chat.draftStarters.sectionBuiltIn' | 'chat.draftStarters.sectionCommands' | 'chat.draftStarters.sectionSkills' }[] = [
    { key: 'built-in', headingKey: 'chat.draftStarters.sectionBuiltIn' },
    { key: 'command', headingKey: 'chat.draftStarters.sectionCommands' },
    { key: 'skill', headingKey: 'chat.draftStarters.sectionSkills' },
];

/** What can be done to a starter that did not fit the row, from the "+" dialog. */
export type OverflowActions = {
    onRun: (starter: ResolvedStarter) => void;
    onRemove: (starter: ResolvedStarter) => void;
    /** Project starters: into the team's shared file, or back out of it. */
    onToggleShared: (starter: ResolvedStarter) => void;
    /** Moves it to the front of its group, back into the row; null when it cannot move. */
    moveToFrontTarget: (starter: ResolvedStarter) => string | null;
    onMoveToFront: (starter: ResolvedStarter, targetId: string) => void;
};

/** One action on an overflowed starter's row; the row itself runs the starter. */
const OverflowAction: React.FC<{ label: string; icon: IconName; onAction: () => void }> = ({ label, icon, onAction }) => (
    <Tooltip>
        <TooltipTrigger asChild>
            <button
                type="button"
                aria-label={label}
                // The row runs the starter on click; this button acts on its own.
                onClick={(event) => { event.stopPropagation(); onAction(); }}
                // Enter and Space press this button and nothing else: bubbling
                // to the list, Enter would run the highlighted starter instead
                // and close the dialog. The default stays, so the browser still
                // turns the key into this button's click.
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                }}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground"
            >
                <Icon name={icon} className="size-3.5" />
            </button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
);

export const StarterPickerList: React.FC<{
    pinnable: PinnableItem[];
    onPick: (item: PinnableItem) => void;
    /** Starters that did not fit the row: they run and are managed from here. */
    overflow: ResolvedStarter[];
    actions: OverflowActions;
    className?: string;
}> = ({ pinnable, onPick, overflow, actions, className }) => {
    const { t } = useI18n();
    return (
        <Command className={cn('min-h-0', className)}>
            <CommandInput placeholder={t('chat.draftStarters.searchPlaceholder')} />
            <CommandList>
                <CommandEmpty>{t('chat.draftStarters.empty')}</CommandEmpty>
                {overflow.length > 0 ? (
                    <CommandGroup heading={t('chat.draftStarters.sectionPinned')}>
                        {overflow.map((starter) => {
                            const target = actions.moveToFrontTarget(starter);
                            return (
                                <CommandItem
                                    key={starter.id}
                                    value={`pinned ${starter.label} ${starter.id}`}
                                    onSelect={() => actions.onRun(starter)}
                                >
                                    <Icon name={starter.icon} className="size-3.5 shrink-0 text-muted-foreground" />
                                    <span className="min-w-0 flex-1 truncate">{starter.label}</span>
                                    {/* The same management a chip in the row has on hover. */}
                                    {target ? (
                                        <OverflowAction label={t('chat.draftStarters.moveToFront')} icon="arrow-up-double" onAction={() => actions.onMoveToFront(starter, target)} />
                                    ) : null}
                                    {starter.group === 'project' ? (
                                        <OverflowAction
                                            label={t(starter.shared ? 'chat.draftStarters.makePersonal' : 'chat.draftStarters.share')}
                                            icon={starter.shared ? 'user' : 'team'}
                                            onAction={() => actions.onToggleShared(starter)}
                                        />
                                    ) : null}
                                    {starter.shared ? null : (
                                        <OverflowAction label={t('chat.draftStarters.remove')} icon="close" onAction={() => actions.onRemove(starter)} />
                                    )}
                                </CommandItem>
                            );
                        })}
                    </CommandGroup>
                ) : null}
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
