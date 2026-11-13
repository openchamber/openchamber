import { z } from 'zod';

import type { Session } from '@/lib/opencode/model';

const workflowAgentMarkSchema = z.object({ openchamber: z.object({ kind: z.literal('workflow-agent') }) });

/**
 * A workflow agent's session: a child of the session that proposed the run,
 * marked `openchamber.kind = 'workflow-agent'` by the server when it creates
 * it (`packages/web/server/lib/workflows/agent-session.js`). One run can start
 * a hundred of them, so the sidebar lists no rows for them
 * (`components/session/sidebar/listedChildren.ts`); the run's card and the
 * Workflows panel open them.
 */
export const isWorkflowAgentSession = (session: Session | null | undefined): boolean => (
  workflowAgentMarkSchema.safeParse(session?.metadata).success
);
