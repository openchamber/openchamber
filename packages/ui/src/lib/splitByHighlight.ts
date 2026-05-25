import type { SearchFlags } from '@/stores/useChatSearchStore';

export function buildSearchRegex(query: string, flags: SearchFlags): RegExp | null {
  if (!query) return null;
  try {
    const escaped = flags.regex
      ? query
      : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const source = flags.wholeWord ? `\\b${escaped}\\b` : escaped;
    const regexFlags = flags.caseSensitive ? 'g' : 'gi';
    return new RegExp(source, regexFlags);
  } catch {
    return null;
  }
}

export function splitByHighlight(
  text: string,
  regex: RegExp,
): Array<{ text: string; isMatch: boolean }> {
  const result: Array<{ text: string; isMatch: boolean }> = [];
  let lastIndex = 0;
  // Clone with the global flag to ensure exec() advances correctly.
  const re = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : regex.flags + 'g',
  );
  re.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      result.push({ text: text.slice(lastIndex, match.index), isMatch: false });
    }
    result.push({ text: match[0], isMatch: true });
    lastIndex = match.index + match[0].length;
    // Guard against infinite loop on zero-length matches.
    if (match[0].length === 0) re.lastIndex++;
  }

  if (lastIndex < text.length) {
    result.push({ text: text.slice(lastIndex), isMatch: false });
  }

  return result;
}
