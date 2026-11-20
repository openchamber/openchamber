import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { birthtimeHoldsStill } from './directory-birthtime.js';

const probeFs = ({ advances, followsCtime = false }) => {
  const stats = { dev: 59, ino: 12345, birthtimeMs: 1700000000000, ctimeMs: 1700000000000 };
  let probes = 0;
  return {
    stat: async () => ({ ...stats, birthtimeMs: followsCtime ? stats.ctimeMs : stats.birthtimeMs }),
    mkdtemp: vi.fn(async (prefix) => {
      probes += 1;
      if (advances(probes)) stats.ctimeMs += 1;
      return `${prefix}probe`;
    }),
    rmdir: vi.fn(async () => {}),
  };
};

describe('birthtimeHoldsStill', () => {
  it('probes again when the first probe lands in the same clock tick', async () => {
    const fsImpl = probeFs({ advances: (probe) => probe > 1 });
    expect(await birthtimeHoldsStill(fsImpl, path, '/repo/.git')).toBe(true);
    expect(fsImpl.mkdtemp).toHaveBeenCalledTimes(2);
    expect(fsImpl.rmdir).toHaveBeenCalledTimes(2);
  });

  it('gives up when ctime never moves', async () => {
    const fsImpl = probeFs({ advances: () => false });
    expect(await birthtimeHoldsStill(fsImpl, path, '/repo/.git')).toBe(false);
    expect(fsImpl.mkdtemp).toHaveBeenCalledTimes(4);
  });

  it.each([[1, () => true], [2, (probe) => probe > 1]])(
    'rejects a birthtime that follows ctime once ctime moves, after %i probe(s)', async (probes, advances) => {
      const fsImpl = probeFs({ advances, followsCtime: true });
      expect(await birthtimeHoldsStill(fsImpl, path, '/repo/.git')).toBe(false);
      expect(fsImpl.mkdtemp).toHaveBeenCalledTimes(probes);
    });
});
