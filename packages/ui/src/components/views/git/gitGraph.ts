import type { GitLogEntry } from '@/lib/api/types';

export type LaneColor = string;

/**
 * Describes one visible line/curve in a commit row's SVG.
 * Each segment covers the FULL row height (y=0 to y=100%).
 *
 * Types:
 *  - 'passing'    : straight vertical line, lane active but this row is not its commit
 *  - 'commit-lane': straight vertical line for this commit's lane (has both incoming and outgoing)
 *  - 'top-stub'   : line from y=0 to dot-y only (branch HEAD — no child above)
 *  - 'bottom-stub': line from dot-y to y=100% only (root commit — nothing above)
 *  - 'branch-out' : bezier from (dot-x, dot-y) to (toLane-x, 100%) — new parent lane opens
 *  - 'merge-in'   : bezier from (fromLane-x, 0) to (dot-x, dot-y) — lane converges here
 */
export interface ConnectorSegment {
  fromLane: number;
  toLane: number;
  color: LaneColor;
  type: 'passing' | 'commit-lane' | 'top-stub' | 'bottom-stub' | 'branch-out' | 'merge-in';
}

export interface LanedCommit {
  commit: GitLogEntry;
  lane: number;
  color: LaneColor;
  /** All visible line segments in this row's height. */
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

export function laneColor(lane: number): LaneColor {
  return LANE_COLORS[lane % LANE_COLORS.length];
}

/**
 * Assigns visual lanes to a list of commits (newest-first order).
 *
 * Greedy lane assignment algorithm (O(n)):
 * - activeLanes[i] holds the hash expected next on lane i (or null if free)
 * - Each commit takes the lane that was waiting for it, or the next free lane
 * - Merge commits open new lanes for additional parents
 * - Connectors describe ALL visible lines in each row (both above and below the dot)
 */
export function assignLanes(commits: GitLogEntry[]): LanedCommit[] {
  if (commits.length === 0) return [];

  // activeLanes[i] = hash of the next commit expected on lane i, or null if free
  const activeLanes: Array<string | null> = [];

  const result: LanedCommit[] = [];

  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];

    // Find all lanes waiting for this commit
    const waitingLanes: number[] = [];
    for (let li = 0; li < activeLanes.length; li++) {
      if (activeLanes[li] === commit.hash) {
        waitingLanes.push(li);
      }
    }

    // Use the first waiting lane as the commit's lane
    let assignedLane = waitingLanes.length > 0 ? waitingLanes[0] : -1;
    if (assignedLane === -1) {
      // No existing lane claimed this commit; take the first free lane
      const freeLane = activeLanes.indexOf(null);
      if (freeLane !== -1) {
        assignedLane = freeLane;
      } else {
        assignedLane = activeLanes.length;
        activeLanes.push(null);
      }
    }

    // Mark other waiting lanes as converging here (will emit merge-in connectors)
    const convergingLanes = waitingLanes.slice(1);

    const color = laneColor(assignedLane);
    const hasIncoming = activeLanes[assignedLane] === commit.hash;
    const hasParent = commit.parents.length > 0;

    // Update this commit's lane to point at its first parent
    if (hasParent) {
      activeLanes[assignedLane] = commit.parents[0];
    } else {
      activeLanes[assignedLane] = null;
    }

    // Open new lanes for additional parents (merge commits)
    const extraParentLanes: number[] = [];
    for (let p = 1; p < commit.parents.length; p++) {
      const parentHash = commit.parents[p];
      // Check if another lane is already waiting for this parent
      const existingLane = activeLanes.indexOf(parentHash);
      if (existingLane !== -1) {
        extraParentLanes.push(existingLane);
      } else {
        const freeLane = activeLanes.indexOf(null);
        const newLane = freeLane !== -1 ? freeLane : activeLanes.length;
        activeLanes[newLane] = parentHash;
        if (newLane === activeLanes.length) activeLanes.push(parentHash);
        extraParentLanes.push(newLane);
      }
    }

    // Build connectors: ALL visible line segments in this row
    const connectors: ConnectorSegment[] = [];

    // This commit's own lane segment
    if (hasIncoming && hasParent) {
      connectors.push({ fromLane: assignedLane, toLane: assignedLane, color, type: 'commit-lane' });
    } else if (hasIncoming && !hasParent) {
      connectors.push({ fromLane: assignedLane, toLane: assignedLane, color, type: 'top-stub' });
    } else if (!hasIncoming && hasParent) {
      connectors.push({ fromLane: assignedLane, toLane: assignedLane, color, type: 'bottom-stub' });
    }
    // else: orphan with no parent and no child — just the dot, no lines

    // Merge-in connectors for converging lanes
    for (const convergingLane of convergingLanes) {
      connectors.push({
        fromLane: convergingLane,
        toLane: assignedLane,
        color: laneColor(convergingLane),
        type: 'merge-in',
      });
      // Clear the converging lane
      activeLanes[convergingLane] = null;
    }

    // Branch-out segments for merge commit's extra parents
    for (const extraLane of extraParentLanes) {
      connectors.push({
        fromLane: assignedLane,
        toLane: extraLane,
        color: laneColor(extraLane),
        type: 'branch-out',
      });
    }

    // Passing-through lanes (active but not this commit's lane or extra parent lanes)
    for (let lane = 0; lane < activeLanes.length; lane++) {
      if (activeLanes[lane] === null) continue;
      if (lane === assignedLane) continue;
      if (extraParentLanes.includes(lane)) continue;
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
