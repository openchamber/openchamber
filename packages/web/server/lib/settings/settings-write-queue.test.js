import { describe, expect, it, vi } from 'vitest';

import { createSettingsWriteQueue } from './settings-write-queue.js';

describe('settings write queue', () => {
  it('skips the write when the mutation returns the current document', async () => {
    const current = { publicOrigin: 'https://host.example' };
    const write = vi.fn(async () => {});
    const { updateSettingsFromDisk } = createSettingsWriteQueue(async () => current, write, (save) => save());

    await expect(updateSettingsFromDisk((settings) => settings)).resolves.toBe(current);
    expect(write).not.toHaveBeenCalled();

    await updateSettingsFromDisk((settings) => ({ ...settings, extra: true }));
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith({ publicOrigin: 'https://host.example', extra: true });
  });
});
