import React from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useConversationSelectionStore } from './selectionContext';

export const SaveImageMenu: React.FC<{
    disabled: boolean;
    selectionKey: string;
    onSave: (sourceElement?: HTMLElement | null) => Promise<void>;
}> = ({ disabled, selectionKey, onSave }) => {
    const { t } = useI18n();
    const store = useConversationSelectionStore();
    const [saving, setSaving] = React.useState(false);
    const triggerRef = React.useRef<HTMLButtonElement>(null);
    const save = async () => {
        if (saving || disabled) return;
        setSaving(true);
        const root = triggerRef.current?.closest('[data-message-text-export-root]');
        const source = root?.querySelector<HTMLElement>('[data-message-text-export-source]') ?? null;
        try { await onSave(source); } finally { setSaving(false); }
    };
    return (
        <DropdownMenu>
            <Tooltip>
                <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                        <Button
                            ref={triggerRef}
                            type="button" size="icon" variant="ghost" disabled={disabled || saving}
                            className="h-6 w-6 text-muted-foreground bg-transparent hover:text-foreground hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent focus-visible:ring-2 focus-visible:ring-ring"
                            aria-label={t(saving ? 'chat.messageBody.actions.savingImage' : 'chat.messageBody.actions.saveAsImage')}
                            onPointerDown={(event) => event.stopPropagation()}
                        >
                            <Icon name={saving ? 'loader-4' : 'image-download'} className={saving ? 'h-3 w-3 animate-spin' : 'h-3 w-3'} />
                        </Button>
                    </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent sideOffset={6}>{t(saving ? 'chat.messageBody.actions.savingImage' : 'chat.messageBody.actions.saveAsImage')}</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
                <DropdownMenuItem className="typography-meta" onSelect={() => void save()}>
                    <Icon name="image-download" className="size-4" />
                    {t('chat.export.saveCurrent')}
                </DropdownMenuItem>
                {store ? <DropdownMenuItem className="typography-meta" onSelect={() => store.getState().begin(selectionKey)}>
                    <Icon name="check" className="size-4" />
                    {t('chat.export.selectMore')}
                </DropdownMenuItem> : null}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
