import { isSubagentSession } from '@/lib/sessionWorkLineage';
import { isWorkflowAgentSession } from '@/lib/sessionWorkflowMetadata';
import type { SessionNode } from './types';

const shownAsChildRow = (child: SessionNode, showSubagentSessions: boolean): boolean => (
  !isWorkflowAgentSession(child.session)
  && (showSubagentSessions || !isSubagentSession(child.session))
);

export const listedChildren = (node: SessionNode, showSubagentSessions = true): readonly SessionNode[] => (
  node.children.some((child) => !shownAsChildRow(child, showSubagentSessions))
    ? node.children.filter((child) => shownAsChildRow(child, showSubagentSessions))
    : node.children
);

export const listedRoots = (nodes: readonly SessionNode[], showSubagentSessions: boolean): readonly SessionNode[] => (
  showSubagentSessions ? nodes : nodes.filter((node) => !isSubagentSession(node.session))
);
