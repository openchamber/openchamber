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
  width: number;
};

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
