/**
 * Discord bot guild membership helpers for /api/messenger/test.
 *
 * Discord returns up to 200 guilds per page. Pagination uses `after=<lastId>`.
 */

export const DISCORD_GUILDS_PAGE_LIMIT = 200;
export const DISCORD_GUILDS_MAX_PAGES = 5;

/**
 * Map raw Discord guild objects (or already-normalized pages) to `{ id, name }`.
 * Accepts either a single page array or an array of page arrays.
 *
 * @param {unknown} pages
 * @returns {{ id: string; name: string }[]}
 */
export function normalizeDiscordGuildList(pages) {
  if (!Array.isArray(pages)) return [];

  const first = pages[0];
  const isNestedPages =
    pages.length > 0 &&
    (Array.isArray(first) || (first != null && typeof first === 'object' && Array.isArray(first?.guilds)));

  const flat = isNestedPages
    ? pages.flatMap((page) => {
        if (Array.isArray(page)) return page;
        if (page && typeof page === 'object' && Array.isArray(page.guilds)) return page.guilds;
        return [];
      })
    : pages;

  const out = [];
  const seen = new Set();
  for (const g of flat) {
    if (!g || typeof g !== 'object') continue;
    const id = typeof g.id === 'string' ? g.id : g.id != null ? String(g.id) : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = typeof g.name === 'string' ? g.name : id;
    out.push({ id, name });
  }
  return out;
}

/**
 * Fetch all guilds the bot belongs to, paginating until exhausted or capped.
 * Returns `null` when the guilds request fails (caller should preserve prior UI state).
 * Returns `[]` when the bot is in zero servers.
 *
 * @param {Record<string, string>} headers
 * @param {{
 *   fetchImpl?: typeof fetch;
 *   pageLimit?: number;
 *   maxPages?: number;
 * }} [opts]
 * @returns {Promise<{ id: string; name: string }[] | null>}
 */
export async function fetchDiscordBotGuilds(
  headers,
  {
    fetchImpl = fetch,
    pageLimit = DISCORD_GUILDS_PAGE_LIMIT,
    maxPages = DISCORD_GUILDS_MAX_PAGES,
  } = {},
) {
  const pages = [];
  let after = null;

  for (let page = 0; page < maxPages; page++) {
    const url = new URL('https://discord.com/api/v10/users/@me/guilds');
    url.searchParams.set('limit', String(pageLimit));
    if (after) url.searchParams.set('after', after);

    let gResp;
    try {
      gResp = await fetchImpl(url.toString(), { headers });
    } catch {
      return pages.length > 0 ? normalizeDiscordGuildList(pages) : null;
    }

    if (!gResp.ok) {
      return pages.length > 0 ? normalizeDiscordGuildList(pages) : null;
    }

    let list;
    try {
      list = await gResp.json();
    } catch {
      return pages.length > 0 ? normalizeDiscordGuildList(pages) : null;
    }

    if (!Array.isArray(list)) {
      return pages.length > 0 ? normalizeDiscordGuildList(pages) : null;
    }

    pages.push(list);

    if (list.length < pageLimit) break;
    const lastId = list[list.length - 1]?.id;
    if (lastId == null || lastId === '') break;
    after = String(lastId);
  }

  return normalizeDiscordGuildList(pages);
}
