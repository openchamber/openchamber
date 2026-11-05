/**
 * What each open table last looked like and which changes from outside (the
 * agent, usually) nobody has looked at yet. Kept for the app's lifetime: the
 * viewer remounts a preview when its file changes on disk, and unseen marks
 * must survive that and the next change.
 */
const MAX_TABLES = 50;
type Trace = { cells: Map<string, string>; unseen: Set<string> };
const traces = new Map<string, Trace>();

/** Takes in what the table holds now and returns everything still unseen. The first look marks nothing. */
export const traceChanges = (table: string, cells: Map<string, string>): ReadonlySet<string> => {
  const trace = traces.get(table);
  traces.delete(table);
  const unseen = trace?.unseen ?? new Set<string>();
  if (trace) {
    for (const [key, value] of cells) if (trace.cells.get(key) !== value) unseen.add(key);
    for (const key of trace.cells.keys()) if (!cells.has(key)) unseen.add(key);
  }
  traces.set(table, { cells, unseen });
  if (traces.size > MAX_TABLES) traces.delete(traces.keys().next().value ?? '');
  return new Set(unseen);
};

/** The user's own edit is no news: it moves what the table counts as seen. */
export const noteOwnEdit = (table: string, cells: Map<string, string>): void => {
  traces.set(table, { cells, unseen: traces.get(table)?.unseen ?? new Set() });
};

export const markSeen = (table: string, keys: string[]): ReadonlySet<string> => {
  const unseen = traces.get(table)?.unseen ?? new Set<string>();
  for (const key of keys) unseen.delete(key);
  return new Set(unseen);
};
