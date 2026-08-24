import { z } from 'zod';

import type { SessionMetadataRecord } from './sessionReviewMetadata';

const metadataNamespaceSchema = z.record(z.string(), z.unknown());

/**
 * Remove source-session state that cannot describe an independent message
 * fork. Unknown metadata stays intact because another feature can own it.
 */
export const prepareMessageForkMetadata = (
  metadata: SessionMetadataRecord,
): SessionMetadataRecord => {
  const parsedNamespace = metadataNamespaceSchema.safeParse(metadata.openchamber);
  if (!parsedNamespace.success) return metadata;

  const currentNamespace = parsedNamespace.data;
  const nextNamespace = { ...currentNamespace };
  let changed = false;

  const sourceSessionKeys = [
    'context_obligatory_last_compaction_message_id',
    'assist',
    'goal',
    'reviewSessionID',
    'kind',
    'originalSessionID',
    'btwSessionID',
    'btwBoundaryMessageID',
  ] as const;
  for (const key of sourceSessionKeys) {
    if (!Object.hasOwn(nextNamespace, key)) continue;
    delete nextNamespace[key];
    changed = true;
  }

  if (!changed) return metadata;

  return {
    ...metadata,
    openchamber: nextNamespace,
  };
};
