/**
 * Spritesheet frame layout and animation tracks for built-in pets.
 *
 * Every built-in pet uses the same 8x9 frame grid (frames 192x208, indices
 * row*8+column) and the same named tracks. Track geometry and timings mirror
 * the Codex App catalog: state tracks loop their primary frames for as long
 * as the state is active (`loopStart` marks where looping restarts; the
 * prefix plays once), while idle is a calm breathing loop.
 */

export const SPRITESHEET_COLUMNS = 8;
export const FRAME_WIDTH = 192;
export const FRAME_HEIGHT = 208;

export interface PetAnimationTrack {
    /** Sprite indices into the frame grid, in play order. */
    frames: number[];
    /** Per-frame durations in milliseconds, parallel to `frames`. */
    durations: number[];
    /**
     * Index into `frames` where looping restarts. Frames before it play once,
     * then `frames[loopStart..]` loops. `null` plays the whole track once and
     * stops on the final frame.
     */
    loopStart: number | null;
}

export type PetDisplayState = 'running' | 'needs-input' | 'ready' | 'blocked';

/** Animation state may include transient interaction overrides (e.g. hover). */
export type PetAnimationState = PetDisplayState | 'hover';

type PetAnimationName = 'idle' | 'running' | 'waiting' | 'failed' | 'hover';

/** Row 0: the calm breathing loop used whenever nothing is happening. */
const IDLE: PetAnimationTrack = {
    frames: [0, 1, 2, 3, 4, 5],
    durations: [1680, 660, 660, 840, 840, 1920],
    loopStart: 0,
};

/**
 * Codex app-state track: the primary frames repeat three times and the whole
 * track loops forever (`loopStart: 0`). The pet keeps playing the state
 * animation continuously — running stays running, waiting stays waiting —
 * instead of settling into the idle tail after one pass. The state change
 * itself (not the track ending) returns the pet to idle.
 */
const appStateTrack = (row: number, frameCount: number, frameMs: number, finalMs: number): PetAnimationTrack => {
    const primaryFrames: number[] = [];
    const primaryDurations: number[] = [];
    for (let column = 0; column < frameCount; column++) {
        primaryFrames.push(row * SPRITESHEET_COLUMNS + column);
        primaryDurations.push(column === frameCount - 1 ? finalMs : frameMs);
    }
    const frames = [
        ...primaryFrames,
        ...primaryFrames,
        ...primaryFrames,
    ];
    const durations = [
        ...primaryDurations,
        ...primaryDurations,
        ...primaryDurations,
    ];
    return {
        frames,
        durations,
        loopStart: 0,
    };
};

/**
 * Row 4: happy/excited reaction shown while hovering the pet in idle state.
 * Frames 33-36 are the visible jump cycle (stand -> rise -> fall -> crouch);
 * frames 37-39 are blank in every spritesheet and must never enter the track,
 * or the pet would vanish between jumps. The track plays the jump three times
 * in a row and then stops (`loopStart: null`), letting PetOverlay's existing
 * one-shot logic return the pet to idle.
 */
const HOVER: PetAnimationTrack = {
    frames: [33, 34, 35, 36, 33, 34, 35, 36, 33, 34, 35, 36],
    durations: [140, 140, 180, 180, 140, 140, 180, 180, 140, 140, 180, 180],
    loopStart: null,
};

const PET_ANIMATIONS: Record<PetAnimationName, PetAnimationTrack> = {
    idle: IDLE,
    /** Row 7: busy running. */
    running: appStateTrack(7, 6, 120, 220),
    /** Row 6: waiting for user input. */
    waiting: appStateTrack(6, 6, 150, 260),
    /** Row 5: blocked/failed. */
    failed: appStateTrack(5, 8, 140, 240),
    /** Row 4: happy/excited hover reaction. */
    hover: HOVER,
};

/**
 * The animation shown for a display state, matching the Codex notification
 * semantics: Running -> running, Needs input -> waiting, Blocked -> failed.
 * Ready (idle) uses the calm breathing loop, exactly like Codex when no
 * notification is active.
 */
export function animationForState(state: PetAnimationState): PetAnimationTrack {
    switch (state) {
        case 'running':
            return PET_ANIMATIONS.running;
        case 'needs-input':
            return PET_ANIMATIONS.waiting;
        case 'blocked':
            return PET_ANIMATIONS.failed;
        case 'hover':
            return PET_ANIMATIONS.hover;
        case 'ready':
            return PET_ANIMATIONS.idle;
    }
}

/** Total duration of a track in milliseconds. */
export function trackDuration(track: PetAnimationTrack): number {
    return track.durations.reduce((sum, duration) => sum + duration, 0);
}

/**
 * Frame index for a given elapsed time, honoring the loop structure exactly
 * like Codex: the prefix before `loopStart` plays once, the tail loops, and
 * tracks without `loopStart` stop on the final frame.
 */
export function frameIndexAtElapsed(track: PetAnimationTrack, elapsedMs: number): number {
    const total = trackDuration(track);
    const lastIndex = track.frames.length - 1;

    let effective = elapsedMs;
    if (track.loopStart !== null && track.loopStart < track.frames.length) {
        const prefix = track.durations
            .slice(0, track.loopStart)
            .reduce((sum, duration) => sum + duration, 0);
        const loopLength = total - prefix;
        if (elapsedMs >= total && loopLength > 0) {
            effective = prefix + (elapsedMs - prefix) % loopLength;
        }
    } else if (elapsedMs >= total) {
        return lastIndex;
    }

    let accumulated = 0;
    for (let i = 0; i < track.frames.length; i++) {
        accumulated += track.durations[i];
        if (effective < accumulated) {
            return i;
        }
    }
    return lastIndex;
}
