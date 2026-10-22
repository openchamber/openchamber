/**
 * The child session a sub-agent call started, and the identities that join it.
 *
 * The export joins a call to the child session it started through a recorded
 * identity — the call's metadata, its output envelope, the report the runtime
 * appended. Position in a list is never used, because two sub-agents can
 * start at the same moment and the export must not guess which is which.
 *
 * The identities live in the modules that own them: `lib/opencode/tools.ts`
 * reads a call's metadata, `lib/opencode/subagent-run.ts` reads a reported
 * run, and `components/chat/message/parts/taskToolModel.ts` reads the legacy
 * output envelope. This module only says which of them answers a given
 * question, so the collector, the normalizer and the tree builder ask the
 * same question the same way.
 */

import { isSubagentTool, subagentSessionId } from '@/lib/opencode/tools';
import { readBackgroundSubagentChildID } from '@/lib/opencode/subagent-run';
import { readTaskSessionIdFromOutput, readTaskSessionIdFromRecord } from '@/components/chat/message/parts/taskToolModel';
import type { Part } from '@/lib/opencode/model';
import { readJsonRecord, readTextField } from './values';

/** A tool part, as the identity readers need it. */
type ToolPart = Extract<Part, { type: 'tool' }>;

/**
 * The child session a subagent call started, from every identity the runtime
 * recorded for it. The order matters: the call's own metadata is the
 * authoritative join, the output envelope is the older fallback, and the
 * call's own input is the last resort.
 */
export const readInvocationChildSessionID = (part: ToolPart): string | undefined => {
  if (!isSubagentTool(part.tool)) return undefined;
  const state = part.state;
  if (state.status === 'pending') return undefined;

  const metadata = 'metadata' in state ? state.metadata : undefined;
  const fromMetadata = subagentSessionId(metadata);
  if (fromMetadata) return fromMetadata;

  const fromRecord = readTaskSessionIdFromRecord(metadata);
  if (fromRecord) return fromRecord;

  if (state.status === 'completed') {
    const fromOutput = readTaskSessionIdFromOutput(state.output);
    if (fromOutput) return fromOutput;
  }

  const fromInput = readTaskSessionIdFromRecord(state.input);
  if (fromInput) return fromInput;

  return undefined;
};

/**
 * The child session a background subagent call left running. The call settles
 * at once with the child in its metadata; the report arrives later.
 */
export const readBackgroundChildID = (part: ToolPart): string | undefined => {
  const background = readBackgroundSubagentChildID(part);
  if (background) return background;
  if (part.state.status === 'completed' && isSubagentTool(part.tool)) {
    const metadata = readJsonRecord(part.state.metadata);
    if (metadata?.status === 'running') {
      const sessionID = readTextField(metadata.sessionID);
      if (sessionID) return sessionID;
    }
  }
  return undefined;
};
