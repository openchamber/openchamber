import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { updateDesktopSettings } from '@/lib/persistence';
import {
    selectReferencePreviewDisplay,
    useReferencePreviewDisplayStore,
    writeReferencePreviewDisplay,
    type ReferencePreviewDisplaySettings,
} from '@/stores/useReferencePreviewDisplayStore';

import { REFERENCE_META_TEXT } from './referencePickerItems';

const TRIGGER_CLASS = cn(
    'inline-flex size-6 shrink-0 items-center justify-center rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    REFERENCE_META_TEXT,
);
const ITEM_CLASS = 'flex items-center gap-2';

const saveDisplay = (changes: Partial<ReferencePreviewDisplaySettings>): void => {
    writeReferencePreviewDisplay(changes);
    void updateDesktopSettings(changes);
};
const setNewestFirst = (value: boolean) => saveDisplay({ referencePreviewNewestFirst: value });
const setCollapseDescription = (value: boolean) => saveDisplay({ referencePreviewCollapseDescription: value });

export const PreviewDisplayMenu: React.FC = () => {
    const { t } = useI18n();
    const newestFirst = useReferencePreviewDisplayStore((state) => selectReferencePreviewDisplay(state).referencePreviewNewestFirst);
    const collapseDescription = useReferencePreviewDisplayStore((state) => selectReferencePreviewDisplay(state).referencePreviewCollapseDescription);
    const label = t('references.picker.preview.display.label');

    const toggle = (
        checked: boolean,
        icon: React.ComponentProps<typeof Icon>['name'],
        labelKey: I18nKey,
        onToggle: (checked: boolean) => void,
    ) => (
        <DropdownMenuCheckboxItem
            checked={checked}
            closeOnClick={false}
            onCheckedChange={onToggle}
            className={ITEM_CLASS}
        >
            <Icon name={icon} className="h-4 w-4" />
            <span className="flex-1">{t(labelKey)}</span>
        </DropdownMenuCheckboxItem>
    );

    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <button type="button" className={TRIGGER_CLASS} aria-label={label}>
                            <Icon name="more-2" className="size-3.5" />
                        </button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>{label}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-[200px]">
                {toggle(newestFirst, 'arrow-up-down', 'references.picker.preview.display.newestFirst', setNewestFirst)}
                {toggle(collapseDescription, 'contract-up-down', 'references.picker.preview.display.collapseDescription', setCollapseDescription)}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
