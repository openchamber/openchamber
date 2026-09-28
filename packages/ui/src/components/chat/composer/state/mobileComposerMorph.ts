/**
 * The pill ↔ full-composer morph (Capacitor iOS).
 *
 * The swap between the collapsed pill and the full composer is a React
 * conditional: one tree unmounts, the other mounts, and the glass box changes
 * height in a single frame. Left alone that is a visible jump — the box, and
 * the pinned transcript above it, snap by the height difference before the
 * keyboard has even started moving.
 *
 * The morph is a FLIP over that swap: the swap commits at once, then the box is frozen at its old
 * height and animated to the new one with its contents anchored to the
 * bottom edge (the footer icon row and the model/agent row stay where the
 * pill's rows were), the prompt travels from where it was to where it is
 * (the pill's text line rises into the editor, or the editor's first line
 * drops into the pill), gained editor lines unfurl beneath it, and the
 * footer controls that only exist expanded fade in once the box has mostly
 * grown. Everything is measured after the swap, so old and new geometry are
 * both real.
 *
 * The transcript never chases the box: the composer slot is pinned for the
 * tween at the height the transcript should see (the new one on expand, the
 * old one on collapse, since the transcript's end may only shrink once the
 * keyboard has landed), so the slot's ResizeObserver publishes one final
 * inset and keyboardFollowGlide moves scrollTop on the keyboard's curve.
 *
 * The motion is timed to the keyboard: it starts on the `oc:keyboard-anim`
 * event for its direction and runs on the keyboard's shared duration and
 * curve (mobileKeyboardTiming.ts); it ends on the keyboard's settled event.
 * A fallback timer runs it alone when no keyboard event follows (an expand
 * that raises no keyboard, a collapse without a keyboard transition).
 *
 * Only the native iOS shell morphs. Mobile browsers rely on Safari's own
 * reveal scroll; Android resizes the window natively and is not verified
 * against this; reduced motion keeps the instant swap.
 */

import { KEYBOARD_EASING_CSS, KEYBOARD_HIDE_MS, KEYBOARD_SHOW_MS } from '@/lib/mobileKeyboardTiming';
import { isCapacitorApp } from '@/lib/platform';
import type { ComposerMorphEventDetail } from '../../lib/scroll/keyboardFollowGlide';

export type ComposerMorphDirection = 'expand' | 'collapse';

/** The glass box (pill or full) the morph measures and animates. */
const BOX_SELECTOR = '[data-composer-box]';
/** The prompt surface in either state: the pill's text line or the editor block. */
const PROMPT_SELECTOR = '[data-composer-morph-prompt]';
/** The floating composer slot (ChatContainer); pinned for the tween. */
const FLOATING_SLOT_SELECTOR = '[data-composer-slot="floating"]';
/**
 * The anchor on the slot's top edge that carries the status row, recap hint
 * and scroll-to-end button. It follows the box's top edge through the tween
 * via the individual `translate` property, which composes with the keyboard
 * slide's `transform` instead of replacing it.
 */
const RIDERS_SELECTOR = '[data-composer-riders]';
/**
 * Footer controls that exist only in the full composer and land in the row
 * the rising prompt still occupies while the box is short; the attach
 * control (first child) sits where the pill's attach control was and stays.
 */
const ARRIVING_CONTROLS_SELECTOR = '[data-chat-input-footer] .composer-mobile-actions > :not(:first-child)';

/** Morph state on the box while it animates; mobile.css keys on it. */
const MORPH_STATE_ATTR = 'data-composer-morph';

/** Longest wait for the keyboard's own timing before the morph runs alone. */
const KEYBOARD_EVENT_FALLBACK_MS = 120;

/** Slack after the tween's nominal end before styles are cleared. */
const FINISH_SLACK_MS = 40;

const ARRIVAL_DRIFT_PX = 4;

const morphTiming = (direction: ComposerMorphDirection) => ({
    durationMs: direction === 'expand' ? KEYBOARD_SHOW_MS : KEYBOARD_HIDE_MS,
    easing: KEYBOARD_EASING_CSS,
});

const composerMorphSupported = (): boolean => {
    // isCapacitorApp() is false outside a window, so the DOM is present past it.
    if (!isCapacitorApp()) return false;
    if (document.documentElement.classList.contains('oc-platform-android')) return false;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return false;
    return true;
};

const dispatchMorph = (detail: ComposerMorphEventDetail) => {
    window.dispatchEvent(new CustomEvent('oc:composer-morph', { detail }));
};

export interface ComposerMorphController {
    /**
     * Run `swap` (which must commit the pill ↔ composer change synchronously,
     * i.e. via flushSync) as a morph of the box found under `host`. Falls
     * back to a plain swap when the morph is unsupported or there is nothing
     * to measure.
     */
    run: (direction: ComposerMorphDirection, host: HTMLElement | null, swap: () => void) => void;
    /** Abort an in-flight morph and restore the natural layout. */
    cancel: () => void;
}

export function createComposerMorphController(): ComposerMorphController {
    let active: (() => void) | null = null;

    const cancel = () => {
        if (!active) return;
        const cleanup = active;
        active = null;
        cleanup();
    };

    const run: ComposerMorphController['run'] = (direction, host, swap) => {
        if (!host || !composerMorphSupported()) {
            cancel();
            swap();
            return;
        }
        // Measured before cancelling: a swap that interrupts the opposite
        // morph continues from the box's mid-tween geometry rather than
        // snapping to its resting size first.
        const outgoingBox = host.querySelector<HTMLElement>(BOX_SELECTOR);
        const outgoingPrompt = outgoingBox?.querySelector<HTMLElement>(PROMPT_SELECTOR) ?? null;
        const fromRect = outgoingBox?.getBoundingClientRect() ?? null;
        const fromPromptRect = outgoingPrompt?.getBoundingClientRect() ?? null;
        const slot = outgoingBox?.closest<HTMLElement>(FLOATING_SLOT_SELECTOR) ?? null;
        const fromSlotHeight = slot?.getBoundingClientRect().height ?? null;
        cancel();
        swap();

        const box = host.querySelector<HTMLElement>(BOX_SELECTOR);
        if (!box || !fromRect) return;
        const toRect = box.getBoundingClientRect();
        const delta = Math.abs(toRect.height - fromRect.height);
        if (delta < 1) return;
        const prompt = box.querySelector<HTMLElement>(PROMPT_SELECTOR);
        const arriving = direction === 'expand'
            ? Array.from(box.querySelectorAll<HTMLElement>(ARRIVING_CONTROLS_SELECTOR))
            : [];

        const phase = direction === 'expand' ? 'show' : 'hide';
        const timing = morphTiming(direction);
        const animations: Animation[] = [];
        let startTimer: number | null = null;
        let finishTimer: number | null = null;
        let started = false;
        let startedByKeyboard = false;

        // The transcript's inset comes from the slot: on expand it takes the
        // new height at once (the glide carries the viewport there); on
        // collapse it keeps the old height until the keyboard has landed.
        const pinSlot = (height: number) => {
            if (!slot) return;
            slot.style.height = `${height}px`;
            slot.style.alignItems = 'flex-end';
        };
        // The slot's natural height with the box at rest. The form's bottom
        // padding follows the keyboard's root class, which flips only when
        // the keyboard leg starts, so the natural height is re-read then.
        const measureSlotNatural = (): number | null => {
            if (!slot) return null;
            const pinned = slot.style.height;
            const boxHeight = box.style.height;
            slot.style.height = '';
            box.style.height = '';
            const natural = slot.getBoundingClientRect().height;
            slot.style.height = pinned;
            box.style.height = boxHeight;
            return natural;
        };
        if (slot && fromSlotHeight !== null) {
            pinSlot(direction === 'expand' ? slot.getBoundingClientRect().height : fromSlotHeight);
        }
        // The transcript's end changes by the slot's delta, not the box's
        // alone (the form's own padding changes with the keyboard too).
        let slotDelta = fromSlotHeight !== null && slot
            ? Math.abs(slot.getBoundingClientRect().height - fromSlotHeight)
            : delta;
        // Freeze the box at the outgoing height with its rows on the bottom
        // edge; mobile.css supplies the clip and bottom anchoring.
        box.setAttribute(MORPH_STATE_ATTR, direction);
        box.style.height = `${fromRect.height}px`;
        void box.offsetHeight;

        // The prompt starts where the outgoing prompt was.
        let promptOffset = 0;
        let promptGainedHeight = 0;
        if (prompt && fromPromptRect) {
            const promptRect = prompt.getBoundingClientRect();
            promptOffset = fromPromptRect.top - promptRect.top;
            promptGainedHeight = promptRect.height - fromPromptRect.height;
            if (Math.abs(promptOffset) >= 0.5) prompt.style.transform = `translateY(${promptOffset}px)`;
            if (direction === 'expand' && promptGainedHeight >= 0.5) {
                prompt.style.clipPath = `inset(0 0 ${promptGainedHeight}px 0)`;
            }
        }
        for (const control of arriving) control.style.opacity = '0';
        // The riders' natural anchor is the pinned slot's top: the new box top
        // on expand (so they start displaced down to the old one), the old
        // box top on collapse (so they end displaced down to the new one,
        // where the unpin then puts them for real).
        // Their travel is the SLOT's delta (box plus the form's own padding
        // change), the same amount the unpin moves their anchor by.
        const riders = slot?.querySelector<HTMLElement>(RIDERS_SELECTOR) ?? null;
        const ridersTravel = () => ({
            from: direction === 'expand' ? slotDelta : 0,
            to: direction === 'expand' ? 0 : slotDelta,
        });
        if (riders) riders.style.translate = `0 ${ridersTravel().from}px`;

        const restore = () => {
            for (const animation of animations) animation.cancel();
            animations.length = 0;
            box.style.height = '';
            box.removeAttribute(MORPH_STATE_ATTR);
            if (prompt) {
                prompt.style.transform = '';
                prompt.style.clipPath = '';
            }
            for (const control of arriving) control.style.opacity = '';
            if (riders) riders.style.translate = '';
            if (slot) {
                slot.style.height = '';
                slot.style.alignItems = '';
            }
        };
        const cleanup = () => {
            if (startTimer !== null) window.clearTimeout(startTimer);
            if (finishTimer !== null) window.clearTimeout(finishTimer);
            window.removeEventListener('oc:keyboard-anim', handleKeyboardAnim);
            window.removeEventListener('oc:keyboard-settled', handleKeyboardSettled);
            restore();
        };
        const finish = () => {
            if (active !== cleanup) return;
            active = null;
            cleanup();
            if (!startedByKeyboard) {
                dispatchMorph({ phase: 'release', direction, delta: slotDelta, durationMs: timing.durationMs });
            }
        };
        const start = (byKeyboard: boolean) => {
            if (started) return;
            started = true;
            startedByKeyboard = byKeyboard;
            if (startTimer !== null) {
                window.clearTimeout(startTimer);
                startTimer = null;
            }
            window.removeEventListener('oc:keyboard-anim', handleKeyboardAnim);
            // Re-read the resting geometry now that the keyboard's root class
            // has flipped, so the pinned inset (expand) and the announced
            // delta (collapse) match what the slot will measure at release —
            // a stale value here is a few-pixel re-pin after the motion.
            if (slot && fromSlotHeight !== null) {
                const natural = measureSlotNatural();
                if (natural !== null) {
                    slotDelta = Math.abs(natural - fromSlotHeight);
                    if (direction === 'expand') pinSlot(natural);
                    dispatchMorph({ phase: 'hold', direction, delta: slotDelta, durationMs: timing.durationMs });
                }
            }
            const options: KeyframeAnimationOptions = { duration: timing.durationMs, easing: timing.easing, fill: 'forwards' };
            animations.push(box.animate([{ height: `${fromRect.height}px` }, { height: `${toRect.height}px` }], options));
            if (prompt) {
                if (Math.abs(promptOffset) >= 0.5) {
                    animations.push(prompt.animate([{ transform: `translateY(${promptOffset}px)` }, { transform: 'none' }], options));
                }
                if (direction === 'expand' && promptGainedHeight >= 0.5) {
                    // Extra lines unfurl beneath the rising first line instead
                    // of sliding up from under the footer as one block.
                    animations.push(prompt.animate(
                        [{ clipPath: `inset(0 0 ${promptGainedHeight}px 0)` }, { clipPath: 'inset(0 0 0 0)' }],
                        options,
                    ));
                }
            }
            if (riders) {
                // Re-read after the slot delta was refreshed above; the
                // keyframes carry it, so no inline update is needed.
                const travel = ridersTravel();
                animations.push(riders.animate(
                    [{ translate: `0 ${travel.from}px` }, { translate: `0 ${travel.to}px` }],
                    options,
                ));
            }
            for (const control of arriving) {
                // Hidden through the first half while the prompt still crosses
                // the footer row, then in along the direction of travel.
                animations.push(control.animate(
                    [{ opacity: 0, transform: `translateY(${ARRIVAL_DRIFT_PX}px)` }, { opacity: 1, transform: 'none' }],
                    { duration: timing.durationMs / 2, delay: timing.durationMs / 2, easing: timing.easing, fill: 'both' },
                ));
            }
            if (!byKeyboard) {
                // No keyboard leg: the transcript glides on the morph alone.
                dispatchMorph({ phase: 'glide', direction, delta: slotDelta, durationMs: timing.durationMs });
                finishTimer = window.setTimeout(finish, timing.durationMs + FINISH_SLACK_MS);
            } else {
                // The keyboard's settled event ends the leg; the timer is a
                // backstop should it never arrive.
                finishTimer = window.setTimeout(finish, timing.durationMs + 4 * FINISH_SLACK_MS);
            }
        };
        function handleKeyboardAnim(event: Event) {
            // SAFETY: oc:keyboard-anim is dispatched only by useNativeMobileChrome
            // as a CustomEvent whose detail carries `phase: 'show' | 'hide'`.
            const detail = (event as CustomEvent<{ phase: 'show' | 'hide' }>).detail;
            if (detail.phase !== phase) return;
            start(true);
        }
        function handleKeyboardSettled(event: Event) {
            // SAFETY: oc:keyboard-settled is dispatched only by useNativeMobileChrome
            // as a CustomEvent whose detail carries `open`.
            const detail = (event as CustomEvent<{ open: boolean }>).detail;
            if (!started || !startedByKeyboard) return;
            if (detail.open !== (phase === 'show')) return;
            finish();
        }

        dispatchMorph({ phase: 'hold', direction, delta: slotDelta, durationMs: timing.durationMs });
        window.addEventListener('oc:keyboard-anim', handleKeyboardAnim);
        window.addEventListener('oc:keyboard-settled', handleKeyboardSettled);
        startTimer = window.setTimeout(() => {
            startTimer = null;
            start(false);
        }, KEYBOARD_EVENT_FALLBACK_MS);
        active = cleanup;
    };

    return { run, cancel };
}
