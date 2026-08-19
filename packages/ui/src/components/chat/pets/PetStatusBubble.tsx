/**
 * The status speech bubble shown above the pet: the localized state label
 * plus, on `ready`, a preview of the last assistant reply. Shared by the
 * in-app pet (PetBubble) and the desktop overlay window (PetOverlay).
 */

import React from 'react';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { PetDisplayState } from './animations';

const STATE_TEXT_KEY: Record<PetDisplayState, I18nKey> = {
    running: 'chat.pets.state.running',
    'needs-input': 'chat.pets.state.needsInput',
    ready: 'chat.pets.state.ready',
    blocked: 'chat.pets.state.blocked',
};

/**
 * Which side of the pet the bubble hangs from. The bubble is always above the
 * pet; the side changes (right-aligned vs left-aligned) when the pet crosses
 * the viewport/display midline so the bubble never overflows the screen edge
 * the pet is dragged toward.
 */
export type BubbleAlign = 'left' | 'right';

/**
 * Hysteresis dead zone around the midline: the bubble keeps its current side
 * until the pet's center crosses the midline by more than this, so small
 * back-and-forth drags near the center do not make it flip repeatedly.
 */
export const BUBBLE_FLIP_DEAD_ZONE_PX = 24;

interface PetStatusBubbleProps {
    state: PetDisplayState;
    /** Collapsed+truncated preview of the last assistant reply, or null. */
    preview: string | null;
    petSize: number;
    /** Side of the pet the bubble hangs from; defaults to right-aligned. */
    align?: BubbleAlign;
    /**
     * Cap the bubble width to half the viewport so it can never overflow the
     * screen after an alignment flip. The desktop overlay window is already
     * clamped to a display work area, so only the in-app pet needs this.
     */
    capToViewportHalf?: boolean;
    /**
     * Render the bubble with a translucent surface instead of the solid
     * popover token. Used by the desktop overlay window, where a solid
     * `--popover` (pure white in light themes) would appear as a stark
     * white block floating over the desktop. In-app bubbles keep the
     * solid popover surface.
     */
    translucent?: boolean;
}

export function PetStatusBubble({
    state,
    preview,
    petSize,
    align = 'right',
    capToViewportHalf = false,
    translucent = false,
}: PetStatusBubbleProps) {
    const { t } = useI18n();
    const statusFontSize = `clamp(0.75rem, 0.875rem * ${petSize}, 1.125rem)`;
    const bodyFontSize = `clamp(0.625rem, 0.75rem * ${petSize}, 1rem)`;
    const bubbleMaxWidth = `${Math.round(16 * petSize)}rem`;
    const cappedMaxWidth = capToViewportHalf
        ? `min(${bubbleMaxWidth}, calc(50vw - 1.5rem))`
        : bubbleMaxWidth;

    const bubbleSurface = translucent
        ? 'bg-[color-mix(in_srgb,var(--popover)_55%,transparent)] after:bg-[color-mix(in_srgb,var(--popover)_55%,transparent)]'
        : 'bg-[var(--popover)] after:bg-[var(--popover)]';

    // The bubble column aligns to the side of the pet it hangs from, and the
    // tail (pointing down at the pet) follows that side. Re-mounting on a flip
    // (key={align} at the call sites) plays the slide-in animation.
    const alignClasses =
        align === 'left'
            ? 'items-start animate-pet-bubble-slide-in-left'
            : 'items-end animate-pet-bubble-slide-in-right';
    const tailSideClass = align === 'left' ? 'after:left-4' : 'after:right-4';

    const statusText = t(STATE_TEXT_KEY[state]);
    const body = state === 'ready' ? preview : null;
    const showStatus = state !== 'ready' && Boolean(statusText);
    const showBody = Boolean(body);

    if (!showStatus && !showBody) {
        return null;
    }

    return (
        <div className={`flex flex-col gap-1.5 ${alignClasses}`}>
            {showStatus && (
                <span
                    className={cn(
                        'rounded-2xl border border-border/60 px-3 py-1.5 font-medium text-[var(--popover-foreground)] shadow-sm',
                        bubbleSurface,
                        !showBody &&
                            `relative after:absolute after:-bottom-[5px] after:h-2 after:w-2 after:rotate-45 after:border-b after:border-r after:border-border/60 ${tailSideClass}`,
                    )}
                    style={{ fontSize: statusFontSize }}
                >
                    {statusText}
                </span>
            )}
            {showBody && (
                <span
                    className={cn(
                        'relative rounded-2xl border border-border/60 px-3 py-1.5 leading-relaxed text-[var(--popover-foreground)]/80 shadow-sm after:absolute after:-bottom-[5px] after:h-2 after:w-2 after:rotate-45 after:border-b after:border-r after:border-border/60',
                        bubbleSurface,
                        tailSideClass,
                    )}
                    style={{ fontSize: bodyFontSize, maxWidth: cappedMaxWidth }}
                >
                    <span className="line-clamp-3 break-words">{body}</span>
                </span>
            )}
        </div>
    );
}
