const EXT_QUALIFIER_RE = /(?:^|\s)ext:([a-zA-Z0-9*.,_-]+)(?:\s|$)/g;

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

export function isTypingExtQualifier(query: string): boolean {
  return /\bext:\s*$/.test(query) || /\bext:[a-zA-Z0-9.,_-]*$/.test(query);
}

export function suggestExtensions(hits: Array<{ extension?: string }>): string[] {
  const counts = new Map<string, number>();
  for (const hit of hits) {
    if (!hit.extension) continue;
    counts.set(hit.extension, (counts.get(hit.extension) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ext]) => ext);
}
