import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { shouldDismissDropdown } from '@/components/ui/dropdown-navigation';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow, MobileSheetSearch } from '@/components/ui/MobileSheetList';
import { SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useGrowingList } from '@/hooks/useGrowingList';
import { useDeviceInfo } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const RENDER_STEP = 50;

type LongVoicePickerProps = {
    voices: readonly string[];
    value: string | null;
    onPick: (id: string) => void;
    onPickCustom: () => void;
    triggerRef: (node: HTMLElement | null) => void;
};

export function LongVoicePicker({ voices, value, onPick, onPickCustom, triggerRef }: LongVoicePickerProps) {
    const { t } = useI18n();
    const { isMobile } = useDeviceInfo();
    const [open, setOpen] = React.useState(false);
    const [query, setQuery] = React.useState('');
    const { limit, reset, listEndRef, contentRef } = useGrowingList({ step: RENDER_STEP, open, query });

    const matches = React.useMemo(() => {
        const needle = query.trim().toLowerCase();
        return needle ? voices.filter((id) => id.toLowerCase().includes(needle)) : voices;
    }, [voices, query]);
    const visible = matches.slice(0, limit);

    const changeQuery = (next: string) => {
        reset();
        setQuery(next);
    };
    const changeOpen = (next: boolean) => {
        setOpen(next);
        if (!next) changeQuery('');
    };
    const choose = (id: string) => {
        onPick(id);
        changeOpen(false);
    };
    const chooseCustom = () => {
        onPickCustom();
        changeOpen(false);
    };

    const label = t('settings.voice.page.field.voice');
    const customLabel = t('settings.voice.page.field.voiceCustom');
    const searchLabel = t('settings.voice.page.voiceList.search');
    const noMatches = matches.length === 0
        ? <div className="px-2 py-6 text-center typography-meta text-muted-foreground">{t('settings.voice.page.voiceList.noMatches')}</div>
        : null;
    const listEnd = open && visible.length < matches.length ? <div ref={listEndRef} aria-hidden="true" className="h-px" /> : null;
    const trigger = (
        <button
            ref={triggerRef}
            type="button"
            aria-label={label}
            onClick={isMobile ? () => changeOpen(true) : undefined}
            className={cn(dropdownTriggerVariants(), SETTINGS_SELECT_ROW_TRIGGER_CLASS, 'shrink-0')}
        >
            <span className="min-w-0 truncate">{value ?? customLabel}</span>
            <Icon name="arrow-down-s" className="size-4 opacity-50" />
        </button>
    );

    if (isMobile) {
        return (
            <>
                {trigger}
                <MobileOverlayPanel
                    open={open}
                    title={label}
                    onClose={() => changeOpen(false)}
                    subheader={<MobileSheetSearch value={query} onChange={changeQuery} placeholder={searchLabel} />}
                    footer={(
                        <MobileSheetRow selected={value === null} onClick={chooseCustom}>{customLabel}</MobileSheetRow>
                    )}
                >
                    <div ref={contentRef}>
                        {noMatches}
                        {visible.map((id) => (
                            <MobileSheetRow key={id} selected={id === value} onClick={() => choose(id)}>
                                <span dir="ltr">{id}</span>
                            </MobileSheetRow>
                        ))}
                        {listEnd}
                    </div>
                </MobileOverlayPanel>
            </>
        );
    }

    return (
        <DropdownMenu open={open} onOpenChange={changeOpen}>
            <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
            <DropdownMenuContent
                ref={contentRef}
                align="start"
                portalToBody
                className="flex max-h-[min(var(--available-height),24rem)] w-[var(--anchor-width)] min-w-[16rem] flex-col overflow-hidden p-0"
            >
                <Command
                    shouldFilter={false}
                    onKeyDown={(event) => { if (!shouldDismissDropdown(event)) event.stopPropagation(); }}
                >
                    <CommandInput autoFocus placeholder={searchLabel} value={query} onValueChange={changeQuery} />
                    <CommandList disableHorizontal>
                        {noMatches}
                        <CommandGroup>
                            {visible.map((id) => (
                                <CommandItem key={id} value={`voice:${id}`} onSelect={() => choose(id)}>
                                    <span dir="ltr" className="min-w-0 flex-1 break-all text-start">{id}</span>
                                    {id === value ? <Icon name="check" className="size-4" /> : null}
                                </CommandItem>
                            ))}
                        </CommandGroup>
                        {listEnd}
                        <div className="oc-surface-elevated sticky bottom-0 bg-surface-elevated">
                            <CommandSeparator alwaysRender />
                            <CommandGroup>
                                <CommandItem value="custom" onSelect={chooseCustom}>
                                    <span className="min-w-0 flex-1">{customLabel}</span>
                                    {value === null ? <Icon name="check" className="size-4" /> : null}
                                </CommandItem>
                            </CommandGroup>
                        </div>
                    </CommandList>
                </Command>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
