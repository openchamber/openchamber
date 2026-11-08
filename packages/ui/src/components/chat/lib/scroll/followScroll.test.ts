import { describe, expect, test } from 'bun:test';

import {
    GLIDE_START_GRACE_MS,
    isFollowGlideUnderWay,
    resolveFollowGlideTarget,
    resolveFollowStop,
    resolvePageRevealTarget,
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

describe('resolvePageRevealTarget', () => {
    test('ends a page that fits at the visible bottom', () => {
        expect(resolvePageRevealTarget({ top: 2600, bottom: 2800 }, 300, 600, 50)).toBe(2200);
    });

    test('starts a page taller than the screen at the top', () => {
        expect(resolvePageRevealTarget({ top: 2600, bottom: 3600 }, 300, 600, 50)).toBe(2550);
        expect(resolvePageRevealTarget({ top: 2600, bottom: 3600 }, 2550, 600, 50)).toBeNull();
    });

    test('leaves a page already in view where it is', () => {
        expect(resolvePageRevealTarget({ top: 2600, bottom: 2800 }, 2300, 600, 50)).toBeNull();
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
