// One clock for every live readout and waiting indicator. Spinners step on a
// 250 ms beat; everything else (blinks, growing dots, elapsed counters)
// changes on every fourth beat, once a second. They all change in the same
// frames, so a page draws four frames a second while a spinner shows, one a
// second while only a counter or a blink does, and none otherwise, however
// many indicators are on screen.

import React from 'react';

import { ClockPausedContext } from './clockPausedContext';

const BEAT_MS = 250;
const BEATS_PER_SECOND = 4;

type Rate = 'beat' | 'second';

/** `step` counts beats for a beat subscriber and seconds for a second one. */
type Subscriber = { rate: Rate; notify: (now: number, step: number) => void };

const subscribers = new Set<Subscriber>();
let beat = 0;
let timerId: number | null = null;
let timerMs = 0;

const stepOf = (rate: Rate): number => (rate === 'beat' ? beat : Math.floor(beat / BEATS_PER_SECOND));

const onTimer = () => {
    // On the 1 s timer the next beat is the next whole second, so seconds stay
    // aligned after a spinner leaves mid-second.
    beat = timerMs === BEAT_MS ? beat + 1 : (Math.floor(beat / BEATS_PER_SECOND) + 1) * BEATS_PER_SECOND;
    const now = Date.now();
    const onSecond = beat % BEATS_PER_SECOND === 0;
    subscribers.forEach((subscriber) => {
        if (subscriber.rate === 'beat' || onSecond) subscriber.notify(now, stepOf(subscriber.rate));
    });
};

/** Runs the timer at the beat while any spinner listens, at 1 s otherwise. */
const syncTimer = () => {
    if (typeof window === 'undefined') return;
    let wanted = 0;
    subscribers.forEach((subscriber) => {
        if (subscriber.rate === 'beat') wanted = BEAT_MS;
        else if (wanted === 0) wanted = BEAT_MS * BEATS_PER_SECOND;
    });
    if (wanted === 0) beat = 0;
    if (wanted === timerMs) return;
    if (timerId !== null) window.clearInterval(timerId);
    timerId = wanted === 0 ? null : window.setInterval(onTimer, wanted);
    timerMs = wanted;
};

const subscribe = (subscriber: Subscriber): (() => void) => {
    subscribers.add(subscriber);
    subscriber.notify(Date.now(), stepOf(subscriber.rate));
    syncTimer();
    return () => {
        subscribers.delete(subscriber);
        syncTimer();
    };
};

const useClockStep = (active: boolean, rate: Rate): number => {
    const paused = React.useContext(ClockPausedContext);
    const running = active && !paused;
    const [step, setStep] = React.useState(() => stepOf(rate));

    React.useEffect(() => {
        if (!running) return;
        return subscribe({ rate, notify: (_now, next) => setStep(next) });
    }, [running, rate]);

    return step;
};

/** Wall-clock time for a live duration readout, updated once a second while `active`. */
export const useDurationTickerNow = (active: boolean): number => {
    const paused = React.useContext(ClockPausedContext);
    const running = active && !paused;
    const [now, setNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (!running) return;
        return subscribe({ rate: 'second', notify: (next) => setNow(next) });
    }, [running]);

    return now;
};

const MINUTE_MS = 60_000;

/**
 * Wall-clock time for labels that change by the minute ("5m ago") on a view
 * that stays open for hours. It listens on the 1 s tick but re-renders only
 * when the minute turns.
 */
export const useMinuteTickerNow = (active: boolean): number => {
    const paused = React.useContext(ClockPausedContext);
    const running = active && !paused;
    const [now, setNow] = React.useState(() => Date.now());

    React.useEffect(() => {
        if (!running) return;
        return subscribe({
            rate: 'second',
            notify: (next) => setNow((current) => (Math.floor(current / MINUTE_MS) === Math.floor(next / MINUTE_MS) ? current : next)),
        });
    }, [running]);

    return now;
};

/**
 * Bright/dim phase for an indicator of a real wait that cannot spin (a status
 * dot, a provider logo, a loading skeleton): `waiting-dim` every other second.
 * Steady states (connected, error) stay still and never call this.
 */
export const useWaitingBlink = (active: boolean): string | undefined => {
    const second = useClockStep(active, 'second');
    return active && second % 2 === 1 ? 'waiting-dim' : undefined;
};

/** Which of `count` phases a waiting indicator shows, advancing once a second. */
export const useWaitingPhase = (active: boolean, count: number): number => {
    const second = useClockStep(active, 'second');
    return active ? second % count : 0;
};

/** Which of `count` positions a spinner shows, advancing four times a second. */
export const useSpinnerPhase = (active: boolean, count: number): number => {
    const step = useClockStep(active, 'beat');
    return active ? step % count : 0;
};
