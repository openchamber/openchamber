import { z } from 'zod';

import { parseMetadata } from '@/lib/metadataParse';
import type { Metadata, Session } from '@/lib/opencode/model';

const workflowAgentMarkSchema = z.object({ openchamber: z.object({ kind: z.literal('workflow-agent') }) });
const workflowAgentLinkSchema = z.object({
  openchamber: z.object({ kind: z.literal('workflow-agent'), parentID: z.string().min(1) }),
});

/**
 * A workflow agent's session, marked `openchamber.kind = 'workflow-agent'` by
 * the server when it creates it (`packages/web/server/lib/workflows/agent-session.js`).
 * One run can start a hundred of them, so the sidebar lists no rows for them
 * (`components/session/sidebar/listedChildren.ts`); the run's card and the
 * Workflows panel open them.
 */
export const isWorkflowAgentSession = (session: Session | null | undefined): boolean => (
  parseMetadata(workflowAgentMarkSchema, session?.metadata).success
);

export const workflowAgentParentId = (metadata: Metadata | undefined): string | undefined => (
  parseMetadata(workflowAgentLinkSchema, metadata).data?.openchamber.parentID
);
