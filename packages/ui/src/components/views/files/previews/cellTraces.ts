/**
 * What each open table last looked like and which changes from outside (the
 * agent, usually) nobody has looked at yet. Kept for the app's lifetime: the
 * viewer remounts a preview when its file changes on disk, and unseen marks
 * must survive that and the next change.
 */
const MAX_TABLES = 50;
type TableRows = readonly (readonly string[])[];
type Trace = (
  | { kind: 'cells'; cells: Map<string, string> }
  | { kind: 'rows'; rows: TableRows }
) & { unseen: Set<string> };
const traces = new Map<string, Trace>();

/** Takes in what the table holds now and returns everything still unseen. The first look marks nothing. */
export const traceChanges = (table: string, cells: Map<string, string>): ReadonlySet<string> => {
  const trace = traces.get(table);
  traces.delete(table);
  const unseen = trace?.unseen ?? new Set<string>();
  if (trace?.kind === 'cells') {
    for (const [key, value] of cells) if (trace.cells.get(key) !== value) unseen.add(key);
    for (const key of trace.cells.keys()) if (!cells.has(key)) unseen.add(key);
  }
  traces.set(table, { kind: 'cells', cells, unseen });
  if (traces.size > MAX_TABLES) traces.delete(traces.keys().next().value ?? '');
  return new Set(unseen);
};

/** Parsed CSV rows stay immutable. Keep them directly instead of allocating a key for every cell. */
export const traceTableRows = (table: string, rows: TableRows, ownEdit = false): ReadonlySet<string> => {
  const trace = traces.get(table);
  traces.delete(table);
  const unseen = trace?.unseen ?? new Set<string>();
  if (!ownEdit && trace?.kind === 'rows') {
    const count = Math.max(trace.rows.length, rows.length);
    for (let row = 0; row < count; row += 1) {
      const before = trace.rows[row];
      const after = rows[row];
      const columns = Math.max(before?.length ?? 0, after?.length ?? 0);
      for (let column = 0; column < columns; column += 1) {
        if (before?.[column] !== after?.[column]) unseen.add(`${row}:${column}`);
      }
    }
  }
  traces.set(table, { kind: 'rows', rows, unseen });
  if (traces.size > MAX_TABLES) traces.delete(traces.keys().next().value ?? '');
  return new Set(unseen);
};

/** An own workbook edit moves the baseline; `all` replaces it, and null means a cell gone. */
export const noteOwnChanges = (table: string, changes: Array<[string, string | null]>, all = false): void => {
  const trace = traces.get(table);
  if (!trace || trace.kind !== 'cells') return;
  if (all) trace.cells.clear();
  for (const [key, value] of changes) {
    if (value === null) trace.cells.delete(key);
    else trace.cells.set(key, value);
  }
};

export const markSeen = (table: string, keys: string[]): ReadonlySet<string> => {
  const unseen = traces.get(table)?.unseen ?? new Set<string>();
  for (const key of keys) unseen.delete(key);
  return new Set(unseen);
};
