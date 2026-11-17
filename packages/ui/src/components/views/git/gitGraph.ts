import type { GitLogEntry } from '@/lib/api/types';

type LaneColor = string;

interface ConnectorSegment {
  fromLane: number;
  toLane: number;
  color: LaneColor;
  type: 'passing' | 'commit-lane' | 'top-stub' | 'bottom-stub' | 'branch-out' | 'merge-in';
}

export interface LanedCommit {
  commit: GitLogEntry;
  lane: number;
  color: LaneColor;
  connectors: ConnectorSegment[];
}

const LANE_COLORS: LaneColor[] = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--syntax-keyword)',
  'var(--syntax-string)',
  'var(--status-info)',
];

function laneColor(lane: number): LaneColor {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

export function assignLanes(commits: GitLogEntry[]): LanedCommit[] {
  if (commits.length === 0) return [];

  const activeLanes: Array<string | null> = [];

  const result: LanedCommit[] = [];

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];

    const waitingLanes: number[] = [];
    for (let li = 0; li < activeLanes.length; li++) {
      if (activeLanes[li] === commit.hash) {
        waitingLanes.push(li);
      }
    }

    let assignedLane = waitingLanes.length > 0 ? waitingLanes[0] : -1;
    if (assignedLane === -1) {
      const freeLane = activeLanes.indexOf(null);
      if (freeLane !== -1) {
        assignedLane = freeLane;
      } else {
        assignedLane = activeLanes.length;
        activeLanes.push(null);
      }
    }

    const convergingLanes = waitingLanes.slice(1);

    const color = laneColor(assignedLane);
    const hasIncoming = activeLanes[assignedLane] === commit.hash;
    const hasParent = commit.parents.length > 0;

    if (hasParent) {
      activeLanes[assignedLane] = commit.parents[0];
    } else {
      activeLanes[assignedLane] = null;
    }

    const extraParentLanes: number[] = [];
    const extraParentIsNew = new Set<number>();
    for (let p = 1; p < commit.parents.length; p++) {
      const parentHash = commit.parents[p];
      const existingLane = activeLanes.indexOf(parentHash);
      if (existingLane !== -1) {
        extraParentLanes.push(existingLane);
      } else {
        const freeLane = activeLanes.indexOf(null);
        if (freeLane !== -1) {
          activeLanes[freeLane] = parentHash;
          extraParentLanes.push(freeLane);
          extraParentIsNew.add(freeLane);
        } else {
          const newLane = activeLanes.length;
          activeLanes.push(parentHash);
          extraParentLanes.push(newLane);
          extraParentIsNew.add(newLane);
        }
      }
    }

    const connectors: ConnectorSegment[] = [];

    if (hasIncoming && hasParent) {
      connectors.push({ fromLane: assignedLane, toLane: assignedLane, color, type: 'commit-lane' });
    } else if (hasIncoming && !hasParent) {
      connectors.push({ fromLane: assignedLane, toLane: assignedLane, color, type: 'top-stub' });
    } else if (!hasIncoming && hasParent) {
      connectors.push({ fromLane: assignedLane, toLane: assignedLane, color, type: 'bottom-stub' });
    }

    for (const convergingLane of convergingLanes) {
      connectors.push({
        fromLane: convergingLane,
        toLane: assignedLane,
        color: laneColor(convergingLane),
        type: 'merge-in',
      });
      activeLanes[convergingLane] = null;
    }

    for (const extraLane of extraParentLanes) {
      connectors.push({
        fromLane: assignedLane,
        toLane: extraLane,
        color: laneColor(extraLane),
        type: 'branch-out',
      });
    }

    for (let lane = 0; lane < activeLanes.length; lane++) {
      if (activeLanes[lane] === null) continue;
      if (lane === assignedLane) continue;
      if (extraParentIsNew.has(lane)) continue;
      connectors.push({
        fromLane: lane,
        toLane: lane,
        color: laneColor(lane),
        type: 'passing',
      });
    }

    result.push({ commit, lane: assignedLane, color, connectors });
  }

  return result;
}
