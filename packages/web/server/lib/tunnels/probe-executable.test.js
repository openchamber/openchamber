import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cachedDependencyProbe, resetDependencyProbeCache } from './probe-executable.js';

const installed = () => ({ available: true, version: 'v1', path: '/usr/bin/thing' });
const absent = () => ({ available: false, version: null, path: null });

describe('tunnel dependency probe cache', () => {
  beforeEach(() => resetDependencyProbeCache());

  it('asks the system once for a dependency it has already found', async () => {
    const probe = vi.fn(async () => installed());

    await cachedDependencyProbe('cloudflared', probe);
    const second = await cachedDependencyProbe('cloudflared', probe);

    expect(probe).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ available: true, version: 'v1' });
  });

  it('keeps looking for a dependency it has not found, so an install is noticed', async () => {
    const probe = vi.fn(async () => absent());

    await cachedDependencyProbe('ngrok', probe);
    await cachedDependencyProbe('ngrok', probe);

    // Caching bad news would make someone who just installed it wait out the cache
    // before the page would admit the dependency exists.
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('goes back to the system when the answer is explicitly asked for again', async () => {
    const probe = vi.fn(async () => installed());

    await cachedDependencyProbe('cloudflared', probe);
    await cachedDependencyProbe('cloudflared', probe, { force: true });

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('lets a held answer expire rather than trusting it forever', async () => {
    const probe = vi.fn(async () => installed());
    let clock = 1_000;

    await cachedDependencyProbe('cloudflared', probe, { now: () => clock });
    clock += 61_000;
    await cachedDependencyProbe('cloudflared', probe, { now: () => clock });

    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('keeps dependencies apart so one does not answer for another', async () => {
    const cloudflared = vi.fn(async () => installed());
    const ngrok = vi.fn(async () => absent());

    await cachedDependencyProbe('cloudflared', cloudflared);
    const other = await cachedDependencyProbe('ngrok', ngrok);

    expect(other.available).toBe(false);
    expect(cloudflared).toHaveBeenCalledTimes(1);
  });
});
