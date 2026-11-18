export type TimelineRevealGate = {
  hold: () => (() => void) | null;
  extendCap: (ms: number) => void;
  close: () => void;
  readonly holds: number;
  readonly capMs: number;
  onEmpty: (() => void) | null;
};

const TIMELINE_REVEAL_CAP_MS = 250;

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
