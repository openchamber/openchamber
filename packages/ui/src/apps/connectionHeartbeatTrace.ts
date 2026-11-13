export const HEARTBEAT_COLUMNS = 60;
export const HEARTBEAT_ROWS = 11;
const BASELINE_ROW = 7;

/** One answer from the server, stamped with the clock beat it landed on. `latencyMs` is null when it never answered. */
export type HeartbeatPing = { beat: number; latencyMs: number | null };

// Rows above the baseline, one entry per beat. The spike's height follows the latency.
const WAVEFORM: ReadonlyArray<number | 'spike'> = [1, 0, -1, 'spike', -2, 0, 1, 1, 0];

/** Log scale: up to ~38 ms is a small blip, ~214 ms and up reaches the top row. */
const spikeHeight = (latencyMs: number): number =>
  Math.min(BASELINE_ROW, Math.max(3, Math.round(Math.log2(Math.max(latencyMs, 1) / 5) * 1.2)));

const heightAt = (beat: number, pings: readonly HeartbeatPing[]): number => {
  for (const ping of pings) {
    const offset = beat - ping.beat;
    if (ping.latencyMs === null || offset < 0 || offset >= WAVEFORM.length) continue;
    const level = WAVEFORM[offset];
    return level === 'spike' ? spikeHeight(ping.latencyMs) : level;
  }
  return 0;
};

/**
 * The lit dots of the trace ending at `beat`, oldest column first. Each column
 * lights the rows from its own height up to, but not including, the previous
 * column's, so a jump draws as a connected vertical stroke.
 */
export const buildHeartbeatTrace = (beat: number, pings: readonly HeartbeatPing[]): Array<{ column: number; row: number }> => {
  const dots: Array<{ column: number; row: number }> = [];
  let previousRow: number | null = null;
  for (let column = 0; column < HEARTBEAT_COLUMNS; column += 1) {
    const row = BASELINE_ROW - heightAt(beat - (HEARTBEAT_COLUMNS - 1 - column), pings);
    if (previousRow === null || previousRow === row) {
      dots.push({ column, row });
    } else {
      const step = row < previousRow ? 1 : -1;
      for (let lit = row; lit !== previousRow; lit += step) dots.push({ column, row: lit });
    }
    previousRow = row;
  }
  return dots;
};
