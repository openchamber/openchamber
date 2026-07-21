import { describe, expect, it, vi } from 'vitest';
import {
  DISCORD_GUILDS_MAX_PAGES,
  DISCORD_GUILDS_PAGE_LIMIT,
  fetchDiscordBotGuilds,
  normalizeDiscordGuildList,
} from './discord-guilds.js';

describe('normalizeDiscordGuildList', () => {
  it('maps a single page of guilds to { id, name }', () => {
    expect(
      normalizeDiscordGuildList([
        { id: '1', name: 'Alpha', owner: true },
        { id: '2', name: 'Beta' },
      ]),
    ).toEqual([
      { id: '1', name: 'Alpha' },
      { id: '2', name: 'Beta' },
    ]);
  });

  it('flattens multiple pages and dedupes by id', () => {
    expect(
      normalizeDiscordGuildList([
        [{ id: '1', name: 'A' }, { id: '2', name: 'B' }],
        [{ id: '2', name: 'B-dup' }, { id: '3', name: 'C' }],
      ]),
    ).toEqual([
      { id: '1', name: 'A' },
      { id: '2', name: 'B' },
      { id: '3', name: 'C' },
    ]);
  });

  it('returns [] for non-arrays', () => {
    expect(normalizeDiscordGuildList(null)).toEqual([]);
    expect(normalizeDiscordGuildList(undefined)).toEqual([]);
    expect(normalizeDiscordGuildList({})).toEqual([]);
  });
});

describe('fetchDiscordBotGuilds', () => {
  it('paginates with after= until a short page and maps results', async () => {
    const page1 = Array.from({ length: DISCORD_GUILDS_PAGE_LIMIT }, (_, i) => ({
      id: String(i + 1),
      name: `G${i + 1}`,
    }));
    const page2 = [
      { id: '201', name: 'G201' },
      { id: '202', name: 'G202' },
    ];

    const fetchImpl = vi.fn(async (url) => {
      const u = new URL(url);
      const after = u.searchParams.get('after');
      const list = after ? page2 : page1;
      return {
        ok: true,
        json: async () => list,
      };
    });

    const guilds = await fetchDiscordBotGuilds(
      { Authorization: 'Bot test' },
      { fetchImpl, pageLimit: DISCORD_GUILDS_PAGE_LIMIT, maxPages: DISCORD_GUILDS_MAX_PAGES },
    );

    expect(guilds).toHaveLength(DISCORD_GUILDS_PAGE_LIMIT + 2);
    expect(guilds?.[0]).toEqual({ id: '1', name: 'G1' });
    expect(guilds?.[DISCORD_GUILDS_PAGE_LIMIT]).toEqual({ id: '201', name: 'G201' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondUrl = String(fetchImpl.mock.calls[1][0]);
    expect(secondUrl).toContain(`after=${DISCORD_GUILDS_PAGE_LIMIT}`);
    expect(secondUrl).toContain(`limit=${DISCORD_GUILDS_PAGE_LIMIT}`);
  });

  it('returns null when the first page fails (preserve prior UI state)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ message: 'boom' }),
    }));
    await expect(
      fetchDiscordBotGuilds({ Authorization: 'Bot test' }, { fetchImpl }),
    ).resolves.toBeNull();
  });

  it('returns [] when Discord returns an empty membership list', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => [],
    }));
    await expect(
      fetchDiscordBotGuilds({ Authorization: 'Bot test' }, { fetchImpl }),
    ).resolves.toEqual([]);
  });

  it('caps pagination at maxPages', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      const page = Array.from({ length: 10 }, (_, i) => ({
        id: `${call}-${i}`,
        name: `P${call}-${i}`,
      }));
      return {
        ok: true,
        json: async () => page,
      };
    });

    const guilds = await fetchDiscordBotGuilds(
      { Authorization: 'Bot test' },
      { fetchImpl, pageLimit: 10, maxPages: 3 },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(guilds).toHaveLength(30);
  });
});
