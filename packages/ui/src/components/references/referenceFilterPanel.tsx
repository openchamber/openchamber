import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { PRESSED_CLASS } from '@/components/ui/action-toolbar';
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { handleDropdownNavigationKey, shouldDismissDropdown } from '@/components/ui/dropdown-navigation';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow, MobileSheetSearch, MobileSheetSection } from '@/components/ui/MobileSheetList';
import { useRevealOnExpand } from '@/hooks/useRevealOnExpand';
import type { Label } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { cn } from '@/lib/utils';

import { labelColor } from './referencePickerItems';
import { ReferenceLabelChips } from './ReferencePickerRow';
import { useRepositoryLabelReader } from './useRepositoryLabelReader';

export type ReferenceFilterGroup = {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onSelect: (value: string) => void;
    taken: boolean;
};

export type ReferenceFilterLabelSection =
    | { kind: 'provider'; directory: string | null; applied: readonly string[]; onChange: (labels: string[]) => void }
    | { kind: 'labels'; choices: readonly Label[]; applied: readonly string[]; onChange: (labels: string[]) => void };

type ReferenceFilterPanelProps = {
    title: string;
    summary: string;
    groups: readonly ReferenceFilterGroup[];
    labelSection?: ReferenceFilterLabelSection | null;
    appearance: 'full' | 'icon';
    mobile?: boolean;
    ariaLabel?: string;
    triggerTitle?: string;
    onClearAll?: () => void;
    positionerClassName?: string;
};

type LabelChoices =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'unsupported' }
    | { status: 'ready'; items: Label[] };

const NO_LABELS: Label[] = [];
const CLEAR_LABELS_VALUE = '\u0000clear';

const UNSUPPORTED_READ = 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED';
const isUnsupported = (error: Error): boolean => 'code' in error && error.code === UNSUPPORTED_READ;

const toggledLabel = (applied: readonly string[], name: string): string[] => (
    applied.includes(name) ? applied.filter((entry) => entry !== name) : [...applied, name]
);

const withApplied = (listed: readonly Label[], applied: readonly string[]) => {
    const names = new Set(listed.map((label) => label.name));
    return [
        ...applied.filter((name) => !names.has(name)).map((name) => ({ name, color: null })),
        ...listed.map((label) => ({ name: label.name, color: labelColor(label.color) })),
    ];
};

const appliedLabelChips = (listed: readonly Label[], applied: readonly string[]) =>
    withApplied(listed, applied).filter((label) => applied.includes(label.name));

const useShownLabels = (listed: readonly Label[], applied: readonly string[], query: string) => {
    const all = React.useMemo(() => withApplied(listed, applied), [applied, listed]);
    return React.useMemo(() => (query ? rankByQuery(all, query, (label) => [label.name]) : all), [all, query]);
};

function useLabelChoices(directory: string | null, applied: readonly string[], query: string) {
    const [choices, setChoices] = React.useState<LabelChoices>({ status: 'loading' });
    const { ready, supported, read } = useRepositoryLabelReader(true, directory);

    const readRef = React.useRef(read);
    React.useEffect(() => { readRef.current = read; }, [read]);
    React.useEffect(() => {
        if (!ready || !supported) return;
        let current = true;
        setChoices({ status: 'loading' });
        void readRef.current().then(
            (items) => { if (current) setChoices({ status: 'ready', items }); },
            (error: Error) => {
                if (!current) return;
                setChoices(isUnsupported(error) ? { status: 'unsupported' } : { status: 'error', message: error.message });
            },
        );
        return () => { current = false; };
    }, [directory, ready, supported]);

    const listed = choices.status === 'ready' ? choices.items : NO_LABELS;
    const shown = useShownLabels(listed, applied, query);
    return { hidden: !supported || choices.status === 'unsupported', choices, shown };
}

const LabelChoicesState: React.FC<{ choices: LabelChoices; empty: boolean }> = ({ choices, empty }) => {
    const { t } = useI18n();
    if (choices.status === 'loading') {
        return (
            <div role="status" className="flex justify-center px-3 py-4">
                <Icon name="loader-4" className="size-4 animate-spin text-muted-foreground" />
            </div>
        );
    }
    if (choices.status === 'error') {
        return (
            <div role="alert" className="px-3 py-2 typography-meta text-muted-foreground">
                <p>{t('references.picker.filter.labels.failed')}</p>
                <p className="mt-1 break-words">{choices.message}</p>
            </div>
        );
    }
    if (!empty) return null;
    return (
        <div role="status" className="px-3 py-4 text-center typography-ui-label text-muted-foreground">
            {t('references.picker.filter.labels.none')}
        </div>
    );
};

type LabelChoicesProps = {
    choices: LabelChoices;
    applied: readonly string[];
    shown: { name: string; color: string | null }[];
    query: string;
    onQueryChange: (query: string) => void;
    onChange: (labels: string[]) => void;
};

const DesktopLabelChoices: React.FC<LabelChoicesProps & { tall: boolean }> = ({ choices, applied, shown, query, onQueryChange, onChange, tall }) => {
    const { t } = useI18n();
    const [activeId, setActiveId] = React.useState<string | null>(null);

    return (
        <Command
            shouldFilter={false}
            value={activeId ?? undefined}
            onValueChange={setActiveId}
            onKeyDown={(event) => { if (!shouldDismissDropdown(event)) event.stopPropagation(); }}
            className="min-h-0"
        >
            <CommandInput
                aria-label={t('references.picker.filter.labels.search')}
                placeholder={t('references.picker.filter.labels.search')}
                value={query}
                onValueChange={onQueryChange}
                onKeyDown={(event) => {
                    if (isIMECompositionEvent(event)) {
                        event.stopPropagation();
                        return;
                    }
                    handleDropdownNavigationKey(event, (key) => {
                        event.currentTarget.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
                    });
                }}
            />
            <CommandList aria-label={t('references.picker.filter.group.labels')} className={tall ? 'max-h-[14rem] pointer-coarse:max-h-[19.25rem]' : 'max-h-48'}>
                <LabelChoicesState choices={choices} empty={shown.length === 0} />
                {shown.map((label) => {
                    const checked = applied.includes(label.name);
                    return (
                        <CommandItem
                            key={label.name}
                            value={label.name}
                            onSelect={() => onChange(toggledLabel(applied, label.name))}
                            className={cn('max-w-full', tall && 'h-8 pointer-coarse:h-11')}
                        >
                            <span className="flex size-4 shrink-0 items-center justify-center">
                                {checked ? <Icon name="check" className="size-4 text-foreground" /> : null}
                            </span>
                            <span className="flex min-w-0 flex-1 items-center gap-2 truncate">
                                <ReferenceLabelChips labels={[label]} />
                            </span>
                        </CommandItem>
                    );
                })}
                {applied.length > 0 ? (
                    <CommandItem value={CLEAR_LABELS_VALUE} onSelect={() => onChange([])} className="text-muted-foreground">
                        <span className="flex size-4 shrink-0 items-center justify-center">
                            <Icon name="close" className="size-3.5" />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{t('references.picker.filter.labels.clear')}</span>
                    </CommandItem>
                ) : null}
            </CommandList>
        </Command>
    );
};

const MobileLabelChoices: React.FC<LabelChoicesProps> = ({ choices, applied, shown, query, onQueryChange, onChange }) => {
    const { t } = useI18n();

    return (
        <>
            <MobileSheetSearch value={query} onChange={onQueryChange} placeholder={t('references.picker.filter.labels.search')} />
            <LabelChoicesState choices={choices} empty={shown.length === 0} />
            {shown.map((label) => (
                <MobileSheetRow key={label.name} selected={applied.includes(label.name)} onClick={() => onChange(toggledLabel(applied, label.name))}>
                    <ReferenceLabelChips labels={[label]} />
                </MobileSheetRow>
            ))}
            {applied.length > 0 ? (
                <MobileSheetRow icon="close" onClick={() => onChange([])}>
                    {t('references.picker.filter.labels.clear')}
                </MobileSheetRow>
            ) : null}
        </>
    );
};

const ProviderLabelSection: React.FC<{ section: Extract<ReferenceFilterLabelSection, { kind: 'provider' }>; mobile: boolean }> = ({ section, mobile }) => {
    const { t } = useI18n();
    const [query, setQuery] = React.useState('');
    const { hidden, choices, shown } = useLabelChoices(section.directory, section.applied, query);
    if (hidden) return null;
    const body = { choices, applied: section.applied, shown, query, onQueryChange: setQuery, onChange: section.onChange };
    const label = t('references.picker.filter.group.labels');
    if (mobile) return <MobileSheetSection title={label}><MobileLabelChoices {...body} /></MobileSheetSection>;
    return (
        <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            <DesktopLabelChoices {...body} tall={false} />
        </>
    );
};

const LocalLabelSection: React.FC<{ section: Extract<ReferenceFilterLabelSection, { kind: 'labels' }>; mobile: boolean }> = ({ section, mobile }) => {
    const { t } = useI18n();
    const [query, setQuery] = React.useState('');
    const [expanded, setExpanded] = React.useState(false);
    const sectionRef = useRevealOnExpand(expanded, mobile ? 'start' : 'end');
    const shown = useShownLabels(section.choices, section.applied, query);
    const toggle = () => {
        setExpanded(!expanded);
        setQuery('');
    };
    const label = t('references.picker.filter.group.labels');
    const body = {
        choices: { status: 'ready', items: [...section.choices] } satisfies LabelChoices,
        applied: section.applied,
        shown,
        query,
        onQueryChange: setQuery,
        onChange: section.onChange,
    };
    const appliedChips = section.applied.length > 0
        ? <ReferenceLabelChips labels={appliedLabelChips(section.choices, section.applied)} max={2} />
        : null;
    if (mobile) {
        return (
            <div ref={sectionRef} role="group" aria-label={label} className="pt-2 first:pt-0">
                <MobileSheetRow
                    icon={expanded ? 'arrow-down-s' : 'arrow-right-s'}
                    aria-expanded={expanded}
                    onClick={toggle}
                    meta={appliedChips ? <span className="flex max-w-[45vw] justify-end overflow-hidden">{appliedChips}</span> : undefined}
                >
                    {label}
                </MobileSheetRow>
                {expanded ? <MobileLabelChoices {...body} /> : null}
            </div>
        );
    }
    return (
        <div ref={sectionRef}>
            <DropdownMenuSeparator />
            <DropdownMenuItem
                asChild
                nativeButton
                closeOnClick={false}
                onSelect={toggle}
                className="w-full text-start font-medium text-muted-foreground hover:bg-transparent hover:text-foreground data-[highlighted]:bg-transparent data-[highlighted]:text-foreground"
            >
                <button type="button" aria-expanded={expanded}>
                    <Icon name={expanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3.5 text-current" />
                    <span className="shrink-0">{label}</span>
                    {appliedChips ? <span className="ms-auto flex min-w-0 justify-end overflow-hidden">{appliedChips}</span> : null}
                </button>
            </DropdownMenuItem>
            {expanded ? <DesktopLabelChoices {...body} tall /> : null}
        </div>
    );
};

const LabelSection: React.FC<{ section: ReferenceFilterLabelSection; mobile: boolean }> = ({ section, mobile }) => (
    section.kind === 'provider'
        ? <ProviderLabelSection section={section} mobile={mobile} />
        : <LocalLabelSection section={section} mobile={mobile} />
);

const MobileReferenceFilterSheet: React.FC<{
    title: string;
    trigger: (open: () => void) => React.ReactNode;
    groups: readonly ReferenceFilterGroup[];
    labelSection: ReferenceFilterLabelSection | null;
    onClearAll?: () => void;
}> = ({ title, trigger, groups, labelSection, onClearAll }) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    return (
        <>
            {trigger(() => setOpen(true))}
            <MobileOverlayPanel open={open} title={title} onClose={() => setOpen(false)}>
                {groups.map((entry) => (
                    <MobileSheetSection key={entry.label} title={entry.label}>
                        {entry.options.map((option) => (
                            <MobileSheetRow
                                key={option.value}
                                selected={option.value === entry.value}
                                disabled={entry.taken}
                                onClick={() => entry.onSelect(option.value)}
                            >
                                {option.label}
                            </MobileSheetRow>
                        ))}
                    </MobileSheetSection>
                ))}
                {labelSection ? <LabelSection section={labelSection} mobile /> : null}
                {onClearAll ? (
                    <MobileSheetRow icon="close" onClick={onClearAll}>
                        {t('session.githubPrPicker.filter.clearAll')}
                    </MobileSheetRow>
                ) : null}
            </MobileOverlayPanel>
        </>
    );
};

export const ReferenceFilterPanel: React.FC<ReferenceFilterPanelProps> = ({
    title,
    summary,
    groups,
    labelSection = null,
    appearance,
    mobile = false,
    ariaLabel,
    triggerTitle,
    onClearAll,
    positionerClassName,
}) => {
    const { t } = useI18n();
    const pressed = summary !== '';
    const accessibleLabel = ariaLabel ?? (pressed ? `${title}: ${summary}` : title);
    const tooltip = triggerTitle ?? (pressed ? `${title} · ${summary}` : title);

    const trigger = (open?: () => void) => {
        const common: React.ComponentProps<'button'> = {
            type: 'button',
            'aria-label': accessibleLabel,
            title: tooltip,
        };
        if (open) {
            common['aria-haspopup'] = 'dialog';
            common.onClick = open;
        }
        if (appearance === 'icon') {
            return (
                <button
                    {...common}
                    aria-pressed={pressed}
                    className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded-md',
                        pressed ? PRESSED_CLASS : 'text-muted-foreground hover:bg-interactive-hover hover:text-foreground',
                    )}
                >
                    <Icon name="filter-3" className="size-4" />
                </button>
            );
        }
        return (
            <button
                {...common}
                className={cn(
                    dropdownTriggerVariants({ size: mobile ? 'mobile' : 'default' }),
                    'min-w-0 max-w-[18rem] shrink-0',
                    mobile && 'max-w-[45%]',
                )}
            >
                <span className="flex min-w-0 items-center gap-1.5">
                    <Icon name="filter-3" className="size-4" />
                    <span className="truncate">{summary}</span>
                </span>
                <Icon name="arrow-down-s" className="size-4 opacity-50" />
            </button>
        );
    };

    if (mobile) {
        return (
            <MobileReferenceFilterSheet
                title={title}
                trigger={trigger}
                groups={groups}
                labelSection={labelSection}
                onClearAll={onClearAll}
            />
        );
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>{trigger()}</DropdownMenuTrigger>
            <DropdownMenuContent
                align="end"
                positionerClassName={positionerClassName}
                className={cn(
                    'overflow-y-auto',
                    appearance === 'icon' ? 'max-h-[min(var(--available-height),60dvh,24rem)]' : 'max-h-[min(var(--available-height),28rem)]',
                    labelSection ? 'w-64' : 'w-56',
                )}
            >
                {groups.map((entry, index) => (
                    <React.Fragment key={entry.label}>
                        {index > 0 ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuLabel>{entry.label}</DropdownMenuLabel>
                        <DropdownMenuRadioGroup value={entry.value} onValueChange={entry.onSelect}>
                            {entry.options.map((option) => (
                                <DropdownMenuRadioItem key={option.value} value={option.value} disabled={entry.taken} className={entry.taken ? 'opacity-50' : undefined}>
                                    {option.label}
                                </DropdownMenuRadioItem>
                            ))}
                        </DropdownMenuRadioGroup>
                    </React.Fragment>
                ))}
                {labelSection ? (
                    <LabelSection section={labelSection} mobile={false} />
                ) : null}
                {onClearAll ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            onSelect={onClearAll}
                            className="text-muted-foreground"
                        >
                            <Icon name="close" className="size-3.5" />
                            <span className="min-w-0 flex-1 truncate">{t('session.githubPrPicker.filter.clearAll')}</span>
                        </DropdownMenuItem>
                    </>
                ) : null}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
