import React from 'react';

/**
 * Coordinates the first paint of a freshly opened session so the timeline
 * appears as one finished picture instead of arriving in pieces.
 *
 * Renderers that mount with a provisional paint (markdown whose blocks are not
 * in the settled cache yet, so code is unhighlighted) take a hold while they
 * catch up. The timeline stays invisible while any hold is open, then reveals
 * everything at once. The gate accepts holds only during the opening commit:
 * rows that mount later, while scrolling, must never hide the timeline.
 *
 * A hold that never releases must not hide the chat forever, so the owner
 * reveals after `capMs` regardless: `TIMELINE_REVEAL_CAP_MS`, unless a hold
 * taken during the opening commit asked for a longer wait.
 */
export type TimelineRevealGate = {
  /** Take a hold; returns the release. Returns null once the gate is closed. */
  hold: () => (() => void) | null;
  /** Raises the reveal cap for this opening; never lowers it. */
  extendCap: (ms: number) => void;
  /** Stops accepting holds. Existing holds still count. */
  close: () => void;
  readonly holds: number;
  readonly capMs: number;
  /** Called when the last hold releases, if the gate is closed by then. */
  onEmpty: (() => void) | null;
};

export const TIMELINE_REVEAL_CAP_MS = 250;

export const createTimelineRevealGate = (): TimelineRevealGate => {
  let holds = 0;
  let accepting = true;
  let capMs = TIMELINE_REVEAL_CAP_MS;
  const gate: TimelineRevealGate = {
    extendCap: (ms) => {
      if (accepting) capMs = Math.max(capMs, ms);
    },
    hold: () => {
      if (!accepting) return null;
      holds += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holds -= 1;
        if (holds === 0 && !accepting) gate.onEmpty?.();
      };
    },
    close: () => {
      accepting = false;
    },
    get holds() {
      return holds;
    },
    get capMs() {
      return capMs;
    },
    onEmpty: null,
  };
  return gate;
};

export const TimelineRevealGateContext = React.createContext<TimelineRevealGate | null>(null);
