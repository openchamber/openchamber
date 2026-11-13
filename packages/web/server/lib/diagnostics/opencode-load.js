import { execFile } from 'node:child_process';

// How much OpenCode is holding right now, for the diagnostic export: the
// directories it has loaded and the processes it started. Every loaded
// directory runs its own copy of the user's local MCP servers, so these two
// numbers explain most "OpenChamber uses N GB" reports. Counts and sizes only;
// no path, name or command leaves this module.

const REQUEST_TIMEOUT_MS = 4_000;
const PS_TIMEOUT_MS = 4_000;

const listProcessesWithPs = () => new Promise((resolve, reject) => {
  execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

/** `ps -o pid=,ppid=,rss=,comm=` output as pid → { ppid, rssKb, command }. Lines that do not parse are skipped. */
export function parseProcessTable(text) {
  const table = new Map();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;
    table.set(Number(match[1]), { ppid: Number(match[2]), rssKb: Number(match[3]), command: match[4] });
  }
  return table;
}

/**
 * The process tree under `rootPid`, or null when that pid is not an OpenCode
 * process on this machine (OpenCode on another host or inside WSL reports a
 * pid that means nothing here).
 */
export function summarizeOpenCodeTree(table, rootPid) {
  const root = table.get(rootPid);
  if (!root || !/opencode/i.test(root.command)) return null;
  const childrenOf = new Map();
  for (const [pid, entry] of table) {
    const siblings = childrenOf.get(entry.ppid) ?? [];
    siblings.push(pid);
    childrenOf.set(entry.ppid, siblings);
  }
  let count = 0;
  let rssKb = 0;
  const pending = [...(childrenOf.get(rootPid) ?? [])];
  const seen = new Set([rootPid]);
  while (pending.length > 0) {
    const pid = pending.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    count += 1;
    rssKb += table.get(pid)?.rssKb ?? 0;
    pending.push(...(childrenOf.get(pid) ?? []));
  }
  return { openCodeMb: Math.round(root.rssKb / 1024), childProcesses: count, childMb: Math.round(rssKb / 1024) };
}

/**
 * `locations` is null when OpenCode did not answer; `processes` is null when
 * they cannot be counted here (Windows, OpenCode elsewhere, `ps` failed).
 */
export async function readOpenCodeLoad({ buildOpenCodeUrl, getOpenCodeAuthHeaders, platform = process.platform, listProcesses = listProcessesWithPs, fetchImpl = fetch }) {
  const readJson = async (route) => {
    const response = await fetchImpl(buildOpenCodeUrl(route, ''), {
      headers: getOpenCodeAuthHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  };

  // Listing loaded locations does not start one.
  const [locations, info] = await Promise.allSettled([readJson('/api/debug/location'), readJson('/api/info')]);
  const locationCount = locations.status === 'fulfilled' && Array.isArray(locations.value) ? locations.value.length : null;
  const pid = info.status === 'fulfilled' && Number.isInteger(info.value?.pid) ? info.value.pid : null;

  let processes = null;
  if (pid !== null && platform !== 'win32') {
    try {
      processes = summarizeOpenCodeTree(parseProcessTable(await listProcesses()), pid);
    } catch {
      processes = null;
    }
  }
  return { locations: locationCount, processes };
}
