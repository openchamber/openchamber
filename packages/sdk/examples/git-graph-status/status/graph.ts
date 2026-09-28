/**
 * Lane layout for the commit graph, ported from OpenChamber's own Git view
 * (`packages/ui/src/components/views/git/gitGraph.ts`) so the section draws
 * the same picture. Commits come newest first (git's topo order).
 *
 * Each connector covers one row's full height:
 *  - `passing`     another lane runs straight through this row
 *  - `commit-lane` this commit's lane, with a child above and a parent below
 *  - `top-stub`    from the top to the dot (no parent: a root commit)
 *  - `bottom-stub` from the dot to the bottom (no child above: a branch tip)
 *  - `branch-out`  curve from the dot down to a merge parent's lane
 *  - `merge-in`    curve from another lane above into the dot
 */
export type GraphCommit = {
  hash: string;
  parents: string[];
};

export type ConnectorType = 'passing' | 'commit-lane' | 'top-stub' | 'bottom-stub' | 'branch-out' | 'merge-in';

export type Connector = {
  fromLane: number;
  toLane: number;
  type: ConnectorType;
};

export type GraphRow = {
  lane: number;
  connectors: Connector[];
};

export type GraphLayout = {
  rows: GraphRow[];
  /** Lanes the widest row needs. */
  width: number;
};

/** Lanes that continue below a row's dot: what an expanded row keeps drawing under itself. */
export const lanesBelow = (row: GraphRow): number[] => {
  const lanes = new Set<number>();
  for (const connector of row.connectors) {
    if (connector.type === 'passing' || connector.type === 'commit-lane' || connector.type === 'bottom-stub') lanes.add(connector.fromLane);
    if (connector.type === 'branch-out') lanes.add(connector.toLane);
  }
  return [...lanes].sort((a, b) => a - b);
};

export const layoutGraph = (commits: readonly GraphCommit[]): GraphLayout => {
  const active: Array<string | null> = [];
  const rows: GraphRow[] = [];
  let width = 0;
  const freeLane = (): number => {
    const index = active.indexOf(null);
    if (index >= 0) return index;
    active.push(null);
    return active.length - 1;
  };

  for (const commit of commits) {
    const waiting = active.flatMap((expected, index) => (expected === commit.hash ? [index] : []));
    const lane = waiting[0] ?? freeLane();
    const hasIncoming = active[lane] === commit.hash;
    const hasParent = commit.parents.length > 0;
    active[lane] = commit.parents[0] ?? null;

    const extraLanes: number[] = [];
    const newExtraLanes = new Set<number>();
    for (const parent of commit.parents.slice(1)) {
      const existing = active.indexOf(parent);
      if (existing >= 0) { extraLanes.push(existing); continue; }
      const opened = freeLane();
      active[opened] = parent;
      extraLanes.push(opened);
      newExtraLanes.add(opened);
    }

    const connectors: Connector[] = [];
    if (hasIncoming && hasParent) connectors.push({ fromLane: lane, toLane: lane, type: 'commit-lane' });
    else if (hasIncoming) connectors.push({ fromLane: lane, toLane: lane, type: 'top-stub' });
    else if (hasParent) connectors.push({ fromLane: lane, toLane: lane, type: 'bottom-stub' });
    for (const converging of waiting.slice(1)) {
      connectors.push({ fromLane: converging, toLane: lane, type: 'merge-in' });
      active[converging] = null;
    }
    for (const extra of extraLanes) connectors.push({ fromLane: lane, toLane: extra, type: 'branch-out' });
    // A reused merge parent already had a lane above, so it keeps its straight segment.
    active.forEach((expected, index) => {
      if (expected === null || index === lane || newExtraLanes.has(index)) return;
      connectors.push({ fromLane: index, toLane: index, type: 'passing' });
    });

    while (active.length > 0 && active[active.length - 1] === null) active.pop();
    for (const connector of connectors) width = Math.max(width, connector.fromLane + 1, connector.toLane + 1);
    width = Math.max(width, lane + 1);
    rows.push({ lane, connectors });
  }
  return { rows, width };
};
