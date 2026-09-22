/**
 * The composer's Enhance Prompt action: rewrites the current draft with the
 * Small Model. One control for the whole lifecycle — while a request runs the
 * sparkle swaps for a spinner on the same button, and that spinner is the
 * escape hatch: tapping it cancels the run instead of waiting on a transport
 * that may never answer. The hook (`../usePromptEnhancer`) owns the request,
 * its guards, and the abort; this button only reflects state and reports taps.
 *
 * VS Code hides the action entirely: like other Small Model features, the
 * extension surface has no composer enhance target.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface PromptEnhanceButtonProps {
    footerIconButtonClass: string;
    iconSizeClass: string;
    /** Empty draft, shell mode, a local command — the action has no target. */
    canEnhance: boolean;
    isEnhancing: boolean;
    onEnhance: () => void;
    /** While enhancing, the button cancels the run instead of being disabled. */
    onCancel?: () => void;
}

export const PromptEnhanceButton = React.memo(function PromptEnhanceButton(props: PromptEnhanceButtonProps) {
    const { t } = useI18n();
    const {
        footerIconButtonClass,
        iconSizeClass,
        canEnhance,
        isEnhancing,
        onEnhance,
        onCancel,
    } = props;

    // While a request runs the same control becomes the cancel affordance;
    // without an escape hatch a lost response frame would trap the user on a
    // spinner until the deadline fires.
    const isCancellable = isEnhancing && Boolean(onCancel);
    const label = isCancellable
        ? t('chat.chatInput.actions.enhancePromptCancel')
        : t('chat.chatInput.actions.enhancePromptAria');

    // The draft is the only thing an enhance can act on, and the rewrite is a
    // Small Model feature like summarize-for-notes: VS Code has no surface for
    // it, so the entry point is hidden entirely.
    if (isVSCodeRuntime()) {
        return null;
    }

    const button = (
        <button
            type="button"
            disabled={!isCancellable && (!canEnhance || isEnhancing)}
            className={cn(footerIconButtonClass, 'rounded-md', !canEnhance && !isCancellable && 'opacity-30')}
            // A tap must not dismiss the mobile keyboard — the enhanced text
            // should land while the user is still looking at the composer.
            onMouseDown={(event) => {
                event.preventDefault();
            }}
            onPointerDownCapture={(event) => {
                if (event.pointerType === 'touch') {
                    event.preventDefault();
                }
            }}
            onClick={isCancellable ? onCancel : onEnhance}
            aria-label={label}
            aria-busy={isEnhancing}
        >
            <Icon name={isEnhancing ? 'loader-4' : 'sparkling'} className={cn(iconSizeClass, isEnhancing && 'animate-spin')} />
        </button>
    );

    return (
        <Tooltip>
            <TooltipTrigger asChild>{button}</TooltipTrigger>
            <TooltipContent side="top" sideOffset={8}>
                {label}
            </TooltipContent>
        </Tooltip>
    );
});

PromptEnhanceButton.displayName = 'PromptEnhanceButton';
