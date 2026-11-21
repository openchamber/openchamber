import { execFile } from 'node:child_process';
import type { OpenCodeLoad, OpenCodeLoadOptions, OpenCodeProcessInfo, ProcessEntry, ProcessSummary } from './contracts.js';


const REQUEST_TIMEOUT_MS = 4_000;
const PS_TIMEOUT_MS = 4_000;

const hasOpenCodePid = (value: unknown): value is OpenCodeProcessInfo => value !== null
  && typeof value === 'object' && 'pid' in value
  && typeof value.pid === 'number' && Number.isInteger(value.pid);

const listProcessesWithPs = () => new Promise<string>((resolve, reject) => {
  execFile('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { timeout: PS_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

export function parseProcessTable(text: string): Map<number, ProcessEntry> {
  const table = new Map<number, ProcessEntry>();
  for (const line of text.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || match[4] === undefined) continue;
    table.set(Number(match[1]), { ppid: Number(match[2]), rssKb: Number(match[3]), command: match[4] });
  }
  return table;
}

export function summarizeOpenCodeTree(
  table: ReadonlyMap<number, ProcessEntry>,
  rootPid: number,
  ownerPid: number = process.pid,
): ProcessSummary | null {
  const root = table.get(rootPid);
  if (!root || (!/opencode/i.test(root.command) && root.ppid !== ownerPid)) return null;
  const childrenOf = new Map<number, number[]>();
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
    if (pid === undefined) continue;
    if (seen.has(pid)) continue;
    seen.add(pid);
    count += 1;
    rssKb += table.get(pid)?.rssKb ?? 0;
    pending.push(...(childrenOf.get(pid) ?? []));
  }
  return { openCodeMb: Math.round(root.rssKb / 1024), childProcesses: count, childMb: Math.round(rssKb / 1024) };
}

export async function readOpenCodeLoad({ buildOpenCodeUrl, getOpenCodeAuthHeaders, platform = process.platform, listProcesses = listProcessesWithPs, fetchImpl = fetch }: OpenCodeLoadOptions): Promise<OpenCodeLoad> {
  const readResponse = async (route: string) => {
    const response = await fetchImpl(buildOpenCodeUrl(route, ''), {
      headers: getOpenCodeAuthHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response;
  };

  const readLocations = async () => {
    const result: unknown = await (await readResponse('/api/debug/location')).json();
    return Array.isArray(result) ? result.length : null;
  };
  const readInfo = async () => {
    const result: unknown = await (await readResponse('/api/info')).json();
    return hasOpenCodePid(result) ? result.pid : null;
  };
  const [locations, info] = await Promise.allSettled([readLocations(), readInfo()]);
  const locationCount = locations.status === 'fulfilled' ? locations.value : null;
  const pid = info.status === 'fulfilled' ? info.value : null;

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
