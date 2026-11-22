import React from 'react';

import type { IconName } from '@/components/icon/icons';
import type { I18nKey } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import type { SubagentRun } from '@/lib/opencode/subagent-run';
import { useSubagentReports } from './useSubagentReports';
import { normalizePath } from '@/lib/pathNormalization';
import { isWorkflowAgentSession } from '@/lib/sessionWorkflowMetadata';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { useSessionWorkflowRuns } from '@/lib/workflows/store';
import { useConfigStore } from '@/stores/useConfigStore';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { isSessionDirectoryAdmitted } from '@/sync/session-admission-rule';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useAllSessionStatuses, useDirectorySync } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { reportFirstLine } from './subagentActivity';
import { useSessionsWithListedChildren } from './useSubagentCostRollup';
import { buildChildrenIndex } from './subagentCost';

export type SubagentRow = {
  child: Session;
  /** 0 for a subagent the viewed session launched, one more per level below. */
  depth: number;
  /** The subagent and every subagent below it, which its row speaks for. */
  subtreeIds: string[];
  blocked: boolean;
  asked: boolean;
  busy: boolean;
  failed: boolean;
  done: boolean;
  finished: boolean;
  detached: boolean;
  identity: string;
  cost: number;
  tokens: number;
  run: SubagentRun | null;
  reportLine: string | null;
};


type SubagentRowLook = { icon: IconName; color: string | undefined; labelKey: I18nKey | null };

const sessionTokenTotal = (child: Session): number => {
  const tokens: Session['tokens'] | undefined = child.tokens;
  if (!tokens) return 0;
  return tokens.input + tokens.output + tokens.reasoning + (tokens.cache?.write ?? 0);
};

export const subagentElapsedMs = (child: Session): number => Math.max(0, (child.time.idle ?? child.time.updated) - child.time.created);

export const subagentRowLook = (row: SubagentRow): SubagentRowLook => {
  if (row.blocked) return { icon: 'alert', color: 'var(--status-warning)', labelKey: 'chat.workStatus.subagent.needsPermission' };
  if (row.asked) return { icon: 'alert', color: 'var(--status-warning)', labelKey: 'chat.workStatus.subagent.askedQuestion' };
  if (row.busy) return { icon: 'record-circle', color: 'var(--status-info)', labelKey: 'chat.workStatus.subagent.working' };
  if (row.failed) return { icon: 'close-circle', color: 'var(--status-error)', labelKey: 'chat.workStatus.subagent.failed' };
  if (row.done) return { icon: 'checkbox-circle', color: 'var(--status-success)', labelKey: 'chat.workStatus.subagent.done' };
  return { icon: 'time', color: undefined, labelKey: null };
};

export const useSubagentRows = (sessionId: string | null, directory: string | null): SubagentRow[] => {
  const providers = useConfigStore((state) => state.providers);
  const projects = useProjectsStore((state) => state.projects);
  const worktrees = useSessionUIStore((state) => state.availableWorktreesByProject);
  const statuses = useAllSessionStatuses();
  const workflowRuns = useSessionWorkflowRuns(sessionId);
  const workflowAgentIds = React.useMemo(
    () => new Set(workflowRuns.flatMap((run) => run.agents.flatMap((agent) => (agent.sessionId ? [agent.sessionId] : [])))),
    [workflowRuns],
  );
  const sessions = useSessionsWithListedChildren(sessionId);
  // Every subagent has a row, nested under the subagent that launched it, and
  // each row speaks for its subagent and everything that one launched.
  const tree = React.useMemo(
    () => buildSubagentTree(sessions, sessionId, (candidate) => !workflowAgentIds.has(candidate.id) && !isWorkflowAgentSession(candidate)),
    [sessions, sessionId, workflowAgentIds],
  );
  const children = React.useMemo(() => flattenTree(tree).map((node) => node.session), [tree]);

  const permissions = useDirectorySync(React.useCallback((state: State) => state.permission, []));
  const forms = useDirectorySync(React.useCallback((state: State) => state.form, []));
  const statusReady = useDirectorySync(
    React.useCallback((state: State) => state.sessionStatusReady, []),
    directory ?? undefined,
  );
  const statusInvalidated = useDirectorySync(
    React.useCallback((state: State) => state.sessionStatusInvalidated, []),
    directory ?? undefined,
  );
  const observedChildren = useGlobalSessionStatusStore(React.useCallback((state) => children
    .flatMap((child) => {
      if (state.statusById.has(child.id)) return [`${child.id}\tbusy`];
      const observed = state.observedById.get(child.id);
      return observed ? [`${child.id}\t${observed.outcome === 'failed' ? 'failed' : 'settled'}`] : [];
    })
    .join('\n'), [children]));
  const indexedRequests = useGlobalBlockingRequestsStore(React.useCallback((state) => children
    .flatMap((child) => {
      const pending = state.bySession.get(child.id);
      if (!pending) return [];
      return [`${child.id}\t${pending.permissions.length > 0 ? 'p' : ''}${pending.forms.length > 0 ? 'f' : ''}`];
    })
    .join('\n'), [children]));

  const reports = useSubagentReports(sessionId, directory, children.length > 0);

  return React.useMemo(() => {
    if (children.length === 0) return [];
    const observedById = new Map<string, string>();
    for (const line of observedChildren.split('\n')) {
      const [id, observed] = line.split('\t');
      if (id && observed) observedById.set(id, observed);
    }
    const requestsById = new Map<string, string>();
    for (const line of indexedRequests.split('\n')) {
      const [id, kinds] = line.split('\t');
      if (id && kinds) requestsById.set(id, kinds);
    }
    const panelDirectory = normalizePath(directory);
    const panelSpaceId = spaceIdOfDirectory(panelDirectory);
    // A session runs while its live status or the global store says so; the
    // same test covers the subagent and everything it launched.
    const isRunning = (id: string): boolean => {
      const type = statuses[id]?.type;
      return type === 'busy' || type === 'retry' || observedById.get(id) === 'busy';
    };
    const describe = (node: SubagentNode) => {
      const child = node.session;
      const blocked = node.subtreeIds.some((id) => (permissions[id]?.length ?? 0) > 0 || Boolean(requestsById.get(id)?.includes('p')));
      const asked = node.subtreeIds.some((id) => (forms[id]?.length ?? 0) > 0 || Boolean(requestsById.get(id)?.includes('f')));
      const status = statuses[child.id]?.type;
      const observed = observedById.get(child.id);
      const busy = node.subtreeIds.some(isRunning);
      const failed = !busy && observed === 'failed';
      const snapshotCovers = statusReady === true && !statusInvalidated?.[child.id]
        && panelDirectory !== null && spaceIdOfDirectory(normalizePath(child.directory)) === panelSpaceId;
      const done = !failed && !busy && (status === 'idle' || (!status && (snapshotCovers || observed === 'settled')));
      const finished = !blocked && !asked && (done || failed);
      const rank = blocked || asked ? 0 : busy ? 1 : finished ? 3 : 2;
      const modelName = getProviderModelDisplayName(
        providers.find((provider) => provider.id === child.model?.providerID),
        child.model?.id,
      );
      const run = reports.get(child.id) ?? null;
      const row: SubagentRow = {
        child,
        depth: node.depth,
        subtreeIds: node.subtreeIds,
        blocked,
        asked,
        busy,
        failed,
        done,
        finished,
        detached: !isSessionDirectoryAdmitted(resolveGlobalSessionDirectory(child), projects, worktrees),
        identity: [child.agent, modelName].filter(Boolean).join(' · '),
        cost: node.cost,
        tokens: sessionTokenTotal(child),
        run,
        reportLine: run ? reportFirstLine(run.output) : null,
      };
      return { row, rank, node };
    };
    // Newest first by creation within each rank, never by last activity.
    // Siblings are ordered at every level, and a subagent's own subagents
    // follow it.
    const orderRows = (nodes: SubagentNode[]): SubagentRow[] => nodes
      .map(describe)
      .sort((left, right) => (left.rank - right.rank)
        || ((right.row.child.time?.created ?? 0) - (left.row.child.time?.created ?? 0)))
      .flatMap(({ row, node }) => [row, ...orderRows(node.children)]);
    return orderRows(tree);
  }, [children, tree, directory, forms, indexedRequests, observedChildren, reports, permissions, projects, providers, statusInvalidated, statusReady, statuses, worktrees]);
};

/** A subagent and, nested under it, the subagents it launched. */
type SubagentNode = {
  session: Session;
  depth: number;
  subtreeIds: string[];
  /** What the subagent and every subagent below it cost. */
  cost: number;
  children: SubagentNode[];
};

/** Every subagent below `rootId`, each nested under the subagent that launched it. */
const buildSubagentTree = (sessions: Session[], rootId: string | null, isListed: (session: Session) => boolean): SubagentNode[] => {
  if (!rootId) return [];
  const childrenByParent = buildChildrenIndex(sessions);
  // A malformed parent cycle must not place a session twice.
  const placed = new Set([rootId]);
  const launchedBy = (parentId: string, depth: number): SubagentNode[] => (childrenByParent.get(parentId) ?? [])
    .flatMap((session) => {
      if (placed.has(session.id) || !isListed(session)) return [];
      placed.add(session.id);
      const children = launchedBy(session.id, depth + 1);
      return [{
        session,
        depth,
        subtreeIds: [session.id, ...children.flatMap((child) => child.subtreeIds)],
        cost: (session.cost ?? 0) + children.reduce((sum, child) => sum + child.cost, 0),
        children,
      }];
    });
  return launchedBy(rootId, 0);
};

const flattenTree = (nodes: SubagentNode[]): SubagentNode[] => nodes.flatMap((node) => [node, ...flattenTree(node.children)]);
