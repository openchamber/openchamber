// When cleanQuery is empty after stripping qualifiers, consumers should fall
// back to `'*'` so the server returns all files for client-side extension
// filtering. This assumes `searchFiles('.', '*', …)` returns file results.
// If that assumption is wrong, change consumers to skip extension-only
// searches (return empty results) instead of sending `'*'`.
//
// Trailing lookahead prevents consuming whitespace so consecutive
// `ext:` qualifiers (e.g. `ext:ts ext:tsx`) are both parsed.
const EXT_QUALIFIER_RE = /(?:^|\s)ext:([a-zA-Z0-9*.,_-]+)(?=\s|$)/g;

export interface ParsedQualifiers {
  cleanQuery: string;
  extensions: string[];
}

function normalizeExtension(ext: string): string | null {
  const normalized = ext.trim().replace(/^\.+/, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
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

export function removeExtQualifier(query: string, extToRemove: string): string {
  const removeTarget = normalizeExtension(extToRemove);
  if (!removeTarget) return query;

  const { cleanQuery, extensions } = parseExtQualifiers(query);
  const remaining = extensions.filter((ext) => ext !== removeTarget);
  const qualifier = remaining.length > 0 ? `ext:${remaining.join(',')}` : '';

  return [qualifier, cleanQuery].filter(Boolean).join(' ').trim();
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


