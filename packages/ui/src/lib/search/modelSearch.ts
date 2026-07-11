/**
 * Normalize a model/provider search string for separator-tolerant matching.
 * Strips punctuation so "GLM 5.2" and "GLM-5.2" share the same compact form.
 */
export function normalizeModelSearchValue(value: string): {
  lower: string;
  compact: string;
  tokens: string[];
} {
  const lower = value.toLowerCase().trim();
  const compact = lower.replace(/[^a-z0-9]/g, '');
  const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
  return { lower, compact, tokens };
}

/**
 * Match a model/provider candidate against a free-typed query.
 * Prefers exact substring, then compact alphanumerics (ignores spaces/hyphens/dots),
 * then per-token prefix/includes so continuous typing still finds the model.
 */
export function matchesModelSearch(candidate: string, query: string): boolean {
  const normalizedQuery = normalizeModelSearchValue(query);
  if (!normalizedQuery.lower) {
    return true;
  }

  const normalizedCandidate = normalizeModelSearchValue(candidate);
  if (normalizedCandidate.lower.includes(normalizedQuery.lower)) {
    return true;
  }

  if (normalizedQuery.compact.length >= 2 && normalizedCandidate.compact.includes(normalizedQuery.compact)) {
    return true;
  }

  if (normalizedQuery.tokens.length === 0) {
    return false;
  }

  return normalizedQuery.tokens.every((queryToken) =>
    normalizedCandidate.tokens.some((candidateToken) =>
      candidateToken.startsWith(queryToken) || candidateToken.includes(queryToken)
    )
  );
}
