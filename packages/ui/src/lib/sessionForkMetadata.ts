import { z } from 'zod';

import { getLinkedIssuesFromMetadata } from './linkedIssues';
import type { SessionMetadataRecord } from './sessionReviewMetadata';

const metadataNamespaceSchema = z.record(z.string(), z.unknown());

/**
 * Remove source-session state that cannot describe a fork at a message
 * boundary. Unknown metadata stays intact because another feature can own it.
 */
export const prepareBoundaryForkMetadata = (
  metadata: SessionMetadataRecord,
  boundaryCreatedAt: number,
): SessionMetadataRecord => {
  const parsedNamespace = metadataNamespaceSchema.safeParse(metadata.openchamber);
  if (!parsedNamespace.success) return metadata;

  const currentNamespace = parsedNamespace.data;
  const nextNamespace = { ...currentNamespace };
  let changed = false;

  if (Array.isArray(currentNamespace.linked_issues)) {
    const linkedIssues = getLinkedIssuesFromMetadata(metadata)
      .filter((issue) => issue.linkedAt <= boundaryCreatedAt);
    if (linkedIssues.length !== currentNamespace.linked_issues.length) {
      nextNamespace.linked_issues = linkedIssues;
      changed = true;
    }
  }

  const sourceSessionKeys = [
    'context_obligatory_last_compaction_message_id',
    'assist',
    'goal',
    'reviewSessionID',
    'kind',
    'originalSessionID',
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
