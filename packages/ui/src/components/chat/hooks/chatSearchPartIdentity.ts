export interface SearchablePartIdentityInput {
  id?: string;
  type: string;
}

export const getSourcePartIndex = <T>(
  sourceParts: readonly T[],
  part: T | undefined,
  fallbackIndex: number,
): number => {
  if (part === undefined) {
    return fallbackIndex;
  }
  const sourceIndex = sourceParts.indexOf(part);
  return sourceIndex === -1 ? fallbackIndex : sourceIndex;
};

/**
 * Uses the server part ID when available. Synthetic ID-less parts use the
 * authoritative source index so duplicate content remains distinguishable and
 * recreated render objects resolve to the same identity.
 */
export const getSearchablePartId = (
  messageId: string,
  part: SearchablePartIdentityInput,
  partIndex: number,
): string => {
  if (typeof part.id === 'string' && part.id.length > 0) {
    return part.id;
  }
  return `${messageId}:${part.type}:${partIndex}`;
};
