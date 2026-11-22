
import { keyboardEase, keyboardKeyframes } from '@/lib/mobileKeyboardTiming';

export interface ComposerMorphEventDetail {
    phase: 'hold' | 'glide' | 'release';
    direction: 'expand' | 'collapse';
    delta: number;
    durationMs: number;
}

interface KeyboardAnimEventDetail {
    phase: 'show' | 'hide';
    slide: number;
    durationMs: number;
    inShell?: boolean;
}

interface KeyboardSettledEventDetail {
    open: boolean;
}

export interface KeyboardFollowGlideOptions {
    scrollNode: HTMLElement;
    canFollow: () => boolean;
}

export interface KeyboardFollowGlide {
    isHeld: () => boolean;
    dispose: () => void;
}

export function createKeyboardFollowGlide(options: KeyboardFollowGlideOptions): KeyboardFollowGlide {
    const { scrollNode, canFollow } = options;
    let held = false;
    let pendingDelta = 0;
    let frame: number | null = null;
    let lastDirection: 'show' | 'hide' | null = null;
    let keyboardLeg = false;

    const endOffset = () => scrollNode.scrollHeight - scrollNode.clientHeight;
    const cancelFrame = () => {
        if (frame !== null) {
            window.cancelAnimationFrame(frame);
            frame = null;
        }
    };

    const hold = (delta: number) => {
        if (!held && !canFollow()) return;
        held = true;
        pendingDelta = delta;
    };

    let motion: {
        animations: Animation[];
        content: HTMLElement;
        headers: HTMLElement[];
        finalTop: number | null;
        endsAt: number;
        observer: ResizeObserver | null;
    } | null = null;

    const contentNode = (): HTMLElement | null => scrollNode.querySelector<HTMLElement>(':scope > .legend-list-content-container');

    const currentOffset = (element: HTMLElement): number => {
        const transform = getComputedStyle(element).transform;
        if (!transform || transform === 'none') return 0;
        return new DOMMatrixReadOnly(transform).m42;
    };

    const settleMotion = (landOnFinal: boolean) => {
        if (!motion) return;
        const { animations, content, finalTop, observer } = motion;
        motion = null;
        observer?.disconnect();
        const top = landOnFinal && finalTop !== null
            ? finalTop
            : scrollNode.scrollTop - currentOffset(content);
        for (const animation of animations) animation.cancel();
        if (Math.abs(top - scrollNode.scrollTop) >= 0.5) scrollNode.scrollTop = top;
    };

    const turnExtent = (content: HTMLElement, header: HTMLElement): { top: number; bottom: number } | null => {
        const head = header.closest<HTMLElement>('[data-turn-id]');
        const turnId = head?.dataset.turnId;
        if (!head || !turnId) return null;
        const headRect = head.getBoundingClientRect();
        const stuck = Math.abs(headRect.top - scrollNode.getBoundingClientRect().top) < 1;
        let top = stuck ? Number.NEGATIVE_INFINITY : headRect.top;
        let bottom = headRect.bottom;
        for (const row of content.querySelectorAll<HTMLElement>(`[data-turn-row="${CSS.escape(turnId)}"]`)) {
            const rect = row.getBoundingClientRect();
            top = Math.min(top, rect.top);
            bottom = Math.max(bottom, rect.bottom);
        }
        return { top, bottom };
    };

    const stuckHeaders = (content: HTMLElement): HTMLElement[] => {
        const top = scrollNode.getBoundingClientRect().top;
        return Array.from(content.querySelectorAll<HTMLElement>('[data-turn-sticky-header]')).filter((header) => {
            const turn = turnExtent(content, header);
            return Boolean(turn) && Math.abs(header.getBoundingClientRect().top - top) < 1 && turn!.bottom > top;
        });
    };

    const crossesStickyEdge = (content: HTMLElement, travel: number): boolean => {
        const top = scrollNode.getBoundingClientRect().top;
        const low = Math.min(0, travel);
        const high = Math.max(0, travel);
        return Array.from(content.querySelectorAll<HTMLElement>('[data-turn-sticky-header]')).some((header) => {
            const turn = turnExtent(content, header);
            if (!turn) return false;
            const edges = [turn.top - top, turn.bottom - header.offsetHeight - top];
            return edges.some((edge) => edge > low && edge <= high);
        });
    };

    const glideScrollTop = (from: number, target: () => number, durationMs: number, startedAt: number) => {
        const step = (now: number) => {
            const progress = durationMs > 0 ? Math.min(1, (now - startedAt) / durationMs) : 1;
            scrollNode.scrollTop = from + (target() - from) * keyboardEase(progress);
            frame = progress < 1 ? window.requestAnimationFrame(step) : null;
        };
        frame = window.requestAnimationFrame(step);
    };

    const animateOffset = (content: HTMLElement, headers: HTMLElement[], from: number, to: number, durationMs: number): Animation[] => {
        const options: KeyframeAnimationOptions = { duration: durationMs, easing: 'linear', fill: 'forwards' };
        const at = (position: number) => from + (to - from) * position;
        return [
            content.animate(keyboardKeyframes((position) => ({ transform: `translateY(${at(position)}px)` })), options),
            ...headers.map((header) => header.animate(keyboardKeyframes((position) => ({ transform: `translateY(${-at(position)}px)` })), options)),
        ];
    };

    const finishWith = (animations: Animation[]) => {
        animations[0]?.addEventListener('finish', () => {
            if (motion?.animations === animations) settleMotion(true);
        });
    };

    const retarget = () => {
        if (!motion || motion.finalTop === null) return;
        const offset = currentOffset(motion.content);
        const target = endOffset();
        if (Math.abs(target - motion.finalTop) < 1) return;
        const remaining = Math.max(16, motion.endsAt - performance.now());
        const visualTop = scrollNode.scrollTop - offset;
        if (crossesStickyEdge(motion.content, target - visualTop)) {
            settleMotion(false);
            glideScrollTop(visualTop, endOffset, remaining, performance.now());
            return;
        }
        for (const animation of motion.animations) animation.cancel();
        motion.animations = animateOffset(motion.content, motion.headers, offset, scrollNode.scrollTop - target, remaining);
        motion.finalTop = target;
        finishWith(motion.animations);
    };

    const glide = (direction: 'show' | 'hide', slide: number, durationMs: number) => {
        if (!held) {
            if (!canFollow()) return;
            held = true;
        }
        cancelFrame();
        settleMotion(false);
        lastDirection = direction;
        const startedAt = performance.now();
        frame = window.requestAnimationFrame((now) => {
            frame = null;
            const content = contentNode();
            const from = scrollNode.scrollTop;
            const target = direction === 'show'
                ? endOffset()
                : Math.max(0, endOffset() - slide - pendingDelta);
            if (direction === 'hide') pendingDelta = 0;
            const travel = target - from;
            if (!content || Math.abs(travel) < 0.5) {
                if (Math.abs(travel) >= 0.5) scrollNode.scrollTop = target;
                return;
            }
            if (crossesStickyEdge(content, travel)) {
                glideScrollTop(from, direction === 'show' ? endOffset : () => target, durationMs, startedAt);
                return;
            }
            const rising = travel > 0;
            if (!rising) scrollNode.scrollTop = target;
            const headers = stuckHeaders(content);
            const animations = rising
                ? animateOffset(content, headers, 0, -travel, durationMs)
                : animateOffset(content, headers, travel, 0, durationMs);
            const elapsed = Math.min(Math.max(0, now - startedAt), durationMs);
            for (const animation of animations) animation.currentTime = elapsed;
            const observer = rising && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(retarget) : null;
            motion = { animations, content, headers, finalTop: rising ? target : null, endsAt: now - elapsed + durationMs, observer };
            observer?.observe(content);
            finishWith(animations);
        });
    };

    const release = () => {
        if (!held) return;
        cancelFrame();
        settleMotion(true);
        held = false;
        keyboardLeg = false;
        pendingDelta = 0;
        if (lastDirection === 'show') {
            const end = endOffset();
            if (Math.abs(end - scrollNode.scrollTop) > 1) scrollNode.scrollTop = end;
        }
        lastDirection = null;
    };

    const handleMorph = (event: Event) => {
        // SAFETY: oc:composer-morph is dispatched only by mobileComposerMorph
        // as a CustomEvent carrying ComposerMorphEventDetail.
        const detail = (event as CustomEvent<ComposerMorphEventDetail>).detail;
        if (detail.phase === 'hold') {
            hold(detail.delta);
            return;
        }
        if (detail.phase === 'glide') {
            glide(detail.direction === 'expand' ? 'show' : 'hide', 0, detail.durationMs);
            return;
        }
        if (keyboardLeg) return;
        release();
    };
    const handleKeyboardAnim = (event: Event) => {
        // SAFETY: oc:keyboard-anim is dispatched only by useNativeMobileChrome
        // as a CustomEvent carrying phase, slide and durationMs.
        const detail = (event as CustomEvent<KeyboardAnimEventDetail>).detail;
        if (detail.inShell === false) return;
        glide(detail.phase, detail.slide, detail.durationMs);
        if (held) keyboardLeg = true;
    };
    const handleKeyboardSettled = (event: Event) => {
        // SAFETY: oc:keyboard-settled is dispatched only by useNativeMobileChrome
        // as a CustomEvent carrying `open`.
        const detail = (event as CustomEvent<KeyboardSettledEventDetail>).detail;
        if (lastDirection === null) return;
        if ((lastDirection === 'show') !== detail.open) return;
        release();
    };

    window.addEventListener('oc:composer-morph', handleMorph);
    window.addEventListener('oc:keyboard-anim', handleKeyboardAnim);
    window.addEventListener('oc:keyboard-settled', handleKeyboardSettled);

    return {
        isHeld: () => held,
        dispose: () => {
            cancelFrame();
            settleMotion(false);
            held = false;
            window.removeEventListener('oc:composer-morph', handleMorph);
            window.removeEventListener('oc:keyboard-anim', handleKeyboardAnim);
            window.removeEventListener('oc:keyboard-settled', handleKeyboardSettled);
        },
    };
}
