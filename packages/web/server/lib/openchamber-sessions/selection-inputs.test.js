import { describe, expect, it, vi } from 'vitest';
import { fetchWarmSelectionInputs } from './selection-inputs.js';

const ready = { agents: [{ id: 'build' }], config: {} };
const cold = { agents: [], config: {} };

describe('fetchWarmSelectionInputs', () => {
  it('reads again until the agents arrive', async () => {
    const read = vi.fn().mockResolvedValueOnce(cold).mockResolvedValueOnce({ agents: null, config: null }).mockResolvedValue(ready);
    const sleep = vi.fn(async () => {});
    await expect(fetchWarmSelectionInputs(read, { sleep, pauseMs: 500 })).resolves.toBe(ready);
    expect(read).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it('gives up at the deadline with the last read, which the caller refuses', async () => {
    let clock = 0;
    const read = vi.fn(async () => cold);
    const sleep = vi.fn(async (ms) => { clock += ms; });
    await expect(fetchWarmSelectionInputs(read, { deadlineMs: 2_000, pauseMs: 500, now: () => clock, sleep })).resolves.toBe(cold);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it('reads once when the first answer is complete', async () => {
    const read = vi.fn(async () => ready);
    await fetchWarmSelectionInputs(read);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
