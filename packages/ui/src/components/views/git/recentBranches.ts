import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { z } from 'zod';

const KEY = 'openchamber:recent-git-branches:v1';
const LIMIT = 5;

const entriesSchema = z.record(z.string(), z.array(z.string()));
type Entries = z.infer<typeof entriesSchema>;

const keyFor = (directory: string): string | null => {
  const normalized = normalizePath(directory);
  return normalized ? `${getRuntimeKey()}:${normalized}` : null;
};

const read = (): Entries => {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = entriesSchema.safeParse(raw ? JSON.parse(raw) : null);
    return parsed.success
      ? Object.fromEntries(Object.entries(parsed.data).map(([key, branches]) => [key, branches.slice(0, LIMIT)]))
      : {};
  } catch { return {}; }
};

export const getRecentBranches = (directory: string): string[] => {
  const key = keyFor(directory);
  return key ? read()[key] ?? [] : [];
};

export const rememberRecentBranch = (directory: string, branch: string): string[] => {
  const key = keyFor(directory);
  if (!key || !branch) return [];
  const entries = read();
  const next = [branch, ...(entries[key] ?? []).filter((item) => item !== branch)].slice(0, LIMIT);
  try { localStorage.setItem(KEY, JSON.stringify({ ...entries, [key]: next })); } catch { /* convenience only */ }
  return next;
};
