// When cleanQuery is empty after stripping qualifiers, consumers should fall
// back to `'*'` so the server returns all files for client-side extension
// filtering. This assumes `searchFiles('.', '*', …)` returns file results.
// If that assumption is wrong, change consumers to skip extension-only
// searches (return empty results) instead of sending `'*'`.
//
// Trailing lookahead prevents consuming whitespace so consecutive
// `ext:` qualifiers (e.g. `ext:ts ext:tsx`) are both parsed.
const EXT_QUALIFIER_RE = /(?:^|\s)ext:([a-zA-Z0-9*.,_-]+)(?=\s|$)/g;

// Path scopes are intentionally one non-whitespace token. Spaces in paths are
// not supported in Tier 3; users can scope to parent directories instead.
const PATH_QUALIFIER_RE = /(?:^|\s)path:([^\s]+)(?=\s|$)/g;

export interface ParsedQualifiers {
  cleanQuery: string;
  extensions: string[];
  pathScope?: string;
}

function normalizeExtension(ext: string): string | null {
  const normalized = ext.trim().replace(/^\.+/, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizePathScope(pathScope: string): string | null {
  const normalized = pathScope
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/g, '');

  if (normalized.length === 0) return null;
  if (normalized.startsWith('/')) return null;

  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '..')) return null;

  return segments.join('/');
}

export function parseExtQualifiers(query: string): ParsedQualifiers {
  const extensions: string[] = [];
  let cleanQuery = query;

  const matches = query.matchAll(EXT_QUALIFIER_RE);
  for (const match of matches) {
    const raw = match[1];
    if (raw.length === 0) continue;
    const exts = raw
      .split(',')
      .map(normalizeExtension)
      .filter((ext): ext is string => Boolean(ext));
    extensions.push(...exts);
    cleanQuery = cleanQuery.replace(match[0], ' ');
  }

  return {
    cleanQuery: cleanQuery.replace(/\s+/g, ' ').trim(),
    extensions: [...new Set(extensions)],
  };
}

export function parseFileSearchQualifiers(query: string): ParsedQualifiers {
  const extParsed = parseExtQualifiers(query);
  let cleanQuery = extParsed.cleanQuery;
  let pathScope: string | undefined;

  const matches = cleanQuery.matchAll(PATH_QUALIFIER_RE);
  for (const match of matches) {
    const raw = match[1];
    const normalized = normalizePathScope(raw);
    if (normalized) {
      pathScope = normalized;
      cleanQuery = cleanQuery.replace(match[0], ' ');
    }
  }

  return {
    cleanQuery: cleanQuery.replace(/\s+/g, ' ').trim(),
    extensions: extParsed.extensions,
    ...(pathScope ? { pathScope } : {}),
  };
}

export function removeExtQualifier(query: string, extToRemove: string): string {
  const removeTarget = normalizeExtension(extToRemove);
  if (!removeTarget) return query;

  const { cleanQuery, extensions } = parseExtQualifiers(query);
  const remaining = extensions.filter((ext) => ext !== removeTarget);
  const qualifier = remaining.length > 0 ? `ext:${remaining.join(',')}` : '';

  return [qualifier, cleanQuery].filter(Boolean).join(' ').trim();
}

export function removePathQualifier(query: string): string {
  return query
    .replace(PATH_QUALIFIER_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function resolvePathScopedDirectory(currentDirectory: string, pathScope?: string): string | null {
  const normalizedRoot = currentDirectory.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalizedRoot) return null;
  if (!pathScope) return normalizedRoot;

  const normalizedScope = normalizePathScope(pathScope);
  if (!normalizedScope) return null;

  return `${normalizedRoot}/${normalizedScope}`;
}

export function filterByExtensions<T extends { extension?: string }>(
  hits: T[],
  extensions: string[]
): T[] {
  if (extensions.length === 0) return hits;
  return hits.filter((hit) => {
    const ext = hit.extension?.toLowerCase();
    return ext && extensions.includes(ext);
  });
}

/** True when the user is actively typing inside an `ext:` qualifier. */
export function isTypingExtQualifier(query: string): boolean {
  return /\bext:[a-zA-Z0-9.,_-]*$/.test(query);
}

/**
 * Appends a selected extension into the query's `ext:` qualifier.
 * Deduplicates — if the extension is already in the list, the query is unchanged.
 *
 * 'ext: auth' + 'ts'   → 'ext:ts auth'
 * 'ext:t auth' + 'tsx'  → 'ext:tsx auth'
 * 'ext:ts, auth' + 'tsx' → 'ext:ts,tsx auth'
 * 'ext:ts auth' + 'ts'   → 'ext:ts auth'
 */
export function completeExtQualifier(query: string, extension: string): string {
  const normalized = normalizeExtension(extension);
  if (!normalized) return query;

  // Match the last ext: qualifier pattern, allowing empty value (e.g. "ext:")
  const EXT_WITH_VALUE = /(?:^|\s)(ext:([a-zA-Z0-9*.,_-]*))/g;

  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;
  EXT_WITH_VALUE.lastIndex = 0;
  while ((match = EXT_WITH_VALUE.exec(query)) !== null) {
    lastMatch = match;
  }

  if (!lastMatch) {
    return `${query} ext:${normalized}`.trim();
  }

  const raw = lastMatch[1];   // "ext:" or "ext:ts" or "ext:ts,"
  const qualifierPrefix = lastMatch[0][0]; // ' ' (space before) or '' (start of string)
  const valStr = lastMatch[2]; // "" or "ts" or "ts,"

  // If value ends with comma, the user is adding another extension.
  // Otherwise, the last value segment is being typed and should be replaced.
  const isAdding = valStr.endsWith(',');

  const currentParts = valStr
    ? valStr.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const normalizedCurrent = currentParts
    .map((e) => normalizeExtension(e))
    .filter((e): e is string => Boolean(e));

  if (normalizedCurrent.includes(normalized)) return query;

  let allExts: string[];

  if (isAdding) {
    allExts = [...normalizedCurrent, normalized];
  } else if (normalizedCurrent.length > 0) {
    // Replace the last (partial) value segment being typed
    allExts = [...normalizedCurrent.slice(0, -1), normalized];
  } else {
    allExts = [normalized];
  }

  const replacement = `ext:${allExts.join(',')}`;
  const matchIndex = lastMatch.index + (qualifierPrefix === ' ' ? 1 : 0);
  return query.slice(0, matchIndex) + replacement + query.slice(matchIndex + raw.length);
}

/**
 * Returns up to 5 extension suggestions from a list of hits,
 * sorted by frequency (most common first), optionally filtered by prefix.
 */
export function suggestExtensions(
  hits: Array<{ extension?: string }>,
  prefix: string
): string[] {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    if (!hit.extension) continue;
    counts.set(hit.extension, (counts.get(hit.extension) ?? 0) + 1);
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([ext]) => ext);

  if (prefix.length === 0) return ranked.slice(0, 5);

  const lower = prefix.toLowerCase();
  return ranked.filter((ext) => ext.startsWith(lower)).slice(0, 5);
}


