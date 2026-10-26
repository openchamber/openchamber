import { describe, expect, test } from 'bun:test';

import {
    AUTOMATIC_MOVEMENT_MAX_MS,
    GLIDE_START_GRACE_MS,
    isFollowGlideUnderWay,
    isPositionHeldByFollow,
    resolveFollowGlideTarget,
    resolveFollowStop,
    resolveViewportAtEnd,
} from './followScroll';

describe('resolveFollowGlideTarget', () => {
    test('glides to the true end whenever any of it is hidden', () => {
        expect(resolveFollowGlideTarget(5000, 5000)).toBeNull();
        expect(resolveFollowGlideTarget(5001, 5000)).toBeNull();
        expect(resolveFollowGlideTarget(5010, 5000)).toBe(5010);
    });
});

describe('resolveFollowStop', () => {
    const tallReply = { limit: 900, bottom: 1700 };

    test('follows to the end while the reply start stays on screen', () => {
        expect(resolveFollowStop(800, tallReply, 600)).toEqual({ target: 800, hold: false });
        expect(resolveFollowStop(901, tallReply, 600)).toEqual({ target: 901, hold: false });
    });

    test('stops at the reply start once the end would carry it off screen', () => {
        expect(resolveFollowStop(1500, tallReply, 600)).toEqual({ target: 900, hold: true });
    });

    test('follows to the end when only growth below a reply that fits carries its start off', () => {
        expect(resolveFollowStop(1500, { limit: 900, bottom: 1400 }, 600)).toEqual({ target: 1500, hold: false });
    });
});

describe('isFollowGlideUnderWay', () => {
    const glide = { lastTop: 1000, issuedAt: 0, stateEnd: 1400 };

    test('a glide still moving toward an unchanged end is left to finish', () => {
        expect(isFollowGlideUnderWay(glide, 1100, 1400, 500)).toBe(true);
        // Not moved yet, but only just issued.
        expect(isFollowGlideUnderWay(glide, 1000, 1400, GLIDE_START_GRACE_MS - 1)).toBe(true);
    });

    test('a glide is re-aimed once the end moved on', () => {
        expect(isFollowGlideUnderWay(glide, 1100, 1450, 500)).toBe(false);
    });

    test('a glide that stopped is checked against the true end again', () => {
        // Stopped short where it landed: the scroll no longer moves.
        expect(isFollowGlideUnderWay(glide, 1000, 1400, 500)).toBe(false);
        expect(isFollowGlideUnderWay(null, 1100, 1400, 500)).toBe(false);
    });
});

describe('isPositionHeldByFollow', () => {
    const glide = { from: 1000, target: 1400, issuedAt: 0 };

    test('holds positions a recent follow glide passes through', () => {
        expect(isPositionHeldByFollow(true, glide, 1000, 100)).toBe(true);
        expect(isPositionHeldByFollow(true, glide, 1200, 100)).toBe(true);
        expect(isPositionHeldByFollow(true, glide, 1400, 100)).toBe(true);
    });

    test('measures a scroll the glide does not account for', () => {
        // The thumb or find in page took the viewport above the glide.
        expect(isPositionHeldByFollow(true, glide, 600, 100)).toBe(false);
        // A glide long finished explains nothing.
        expect(isPositionHeldByFollow(true, glide, 1400, AUTOMATIC_MOVEMENT_MAX_MS)).toBe(false);
        expect(isPositionHeldByFollow(true, null, 1400, 100)).toBe(false);
        // The reader took the scroll.
        expect(isPositionHeldByFollow(false, glide, 1200, 100)).toBe(false);
    });
});

describe('resolveViewportAtEnd', () => {
    test('stays at the end for a held position, without measuring', () => {
        let measured = 0;
        const measureAway = () => { measured += 1; return false; };
        expect(resolveViewportAtEnd(true, measureAway)).toBe(true);
        expect(measured).toBe(0);
    });

    test('takes the measured answer otherwise', () => {
        expect(resolveViewportAtEnd(false, () => false)).toBe(false);
        expect(resolveViewportAtEnd(false, () => true)).toBe(true);
    });
});
