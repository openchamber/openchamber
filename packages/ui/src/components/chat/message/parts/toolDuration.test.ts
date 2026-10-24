import { expect, test } from 'bun:test';
import { formatRunDuration } from './toolDuration';

// A run lasts minutes; its length reads as a length, not as a second count.
test('a run under a minute reads in seconds, like a tool call', () => {
    expect(formatRunDuration(1_000, 45_300)).toBe('44.3s');
});

test('a run of minutes reads in minutes and seconds', () => {
    expect(formatRunDuration(1_000, 1_785_400)).toBe('29m 44s');
    expect(formatRunDuration(0, 685_300)).toBe('11m 25s');
});

test('a run over an hour drops the seconds', () => {
    expect(formatRunDuration(0, 3_725_000)).toBe('1h 2m');
});

test('a running run counts whole seconds, whatever its length', () => {
    expect(formatRunDuration(0, undefined, 45_900)).toBe('45s');
    expect(formatRunDuration(0, undefined, 1_784_400)).toBe('29m 44s');
});
