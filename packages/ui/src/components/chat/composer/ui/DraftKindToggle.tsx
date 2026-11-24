import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { setDraftLead } from '@/sync/session-lead';
import { useSessionUIStore } from '@/sync/session-ui-store';

export function DraftKindToggle({ compact = false }: { compact?: boolean }) {
    const { t } = useI18n();
    const descriptionId = React.useId();
    const lead = useSessionUIStore((state) => state.newSessionDraft.lead === true);
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    if (isVSCodeRuntime()) return null;

    const shortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('new_lead', shortcutOverrides), '');
    const optionClass = (active: boolean) => cn(
        'h-7 cursor-pointer rounded-sm px-0.5 transition-colors',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
    );

    return (
        <div
            role="group"
            aria-label={t('chat.draftKind.label')}
            className={cn('inline-flex shrink-0 items-center gap-0.5 px-1', compact ? 'typography-micro font-medium' : 'typography-ui-label')}
        >
            <button type="button" aria-pressed={!lead} onClick={() => setDraftLead(false)} className={optionClass(!lead)}>
                {t('chat.draftKind.session')}
            </button>
            <span aria-hidden="true" className="text-muted-foreground/60">/</span>
            <Tooltip>
                <TooltipTrigger asChild>
                    <button type="button" aria-pressed={lead} aria-describedby={descriptionId} onClick={() => setDraftLead(true)} className={optionClass(lead)}>
                        {t('chat.draftKind.lead')}
                    </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={8} className="max-w-80">
                    <span className="block">{t('chat.draftKind.leadTooltip')}</span>
                    {shortcut ? <span className="mt-1 block text-muted-foreground">{shortcut}</span> : null}
                </TooltipContent>
            </Tooltip>
            <span id={descriptionId} className="sr-only">{t('chat.draftKind.leadTooltip')}</span>
        </div>
    );
}
