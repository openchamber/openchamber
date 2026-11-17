
import React from 'react';

import { ClockPausedContext } from './clockPausedContext';

const BEAT_MS = 250;
const BEATS_PER_SECOND = 4;

type Rate = 'beat' | 'second';

type Subscriber = { rate: Rate; notify: (now: number, step: number) => void };

const subscribers = new Set<Subscriber>();
let beat = 0;
let timerId: number | null = null;
let timerMs = 0;

const stepOf = (rate: Rate): number => (rate === 'beat' ? beat : Math.floor(beat / BEATS_PER_SECOND));

const onTimer = () => {
    beat = timerMs === BEAT_MS ? beat + 1 : (Math.floor(beat / BEATS_PER_SECOND) + 1) * BEATS_PER_SECOND;
    const now = Date.now();
    const onSecond = beat % BEATS_PER_SECOND === 0;
    subscribers.forEach((subscriber) => {
        if (subscriber.rate === 'beat' || onSecond) subscriber.notify(now, stepOf(subscriber.rate));
    });
};

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

export const useWaitingBlink = (active: boolean): string | undefined => {
    const second = useClockStep(active, 'second');
    return active && second % 2 === 1 ? 'waiting-dim' : undefined;
};

export const useWaitingPhase = (active: boolean, count: number): number => {
    const second = useClockStep(active, 'second');
    return active ? second % count : 0;
};

export const useClockBeat = (active: boolean): number => useClockStep(active, 'beat');

export const useSpinnerPhase = (active: boolean, count: number): number => {
    const step = useClockStep(active, 'beat');
    return active ? step % count : 0;
};
