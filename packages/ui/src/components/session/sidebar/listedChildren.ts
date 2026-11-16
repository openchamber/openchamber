import { isWorkflowAgentSession } from '@/lib/sessionWorkflowMetadata';
import type { SessionNode } from './types';

export const listedChildren = (node: SessionNode): readonly SessionNode[] => (
  node.children.some((child) => isWorkflowAgentSession(child.session))
    ? node.children.filter((child) => !isWorkflowAgentSession(child.session))
    : node.children
);
