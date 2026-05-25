import type { SearchFlags } from '@/stores/useChatSearchStore';

/** Maximum regex pattern length to prevent ReDoS from extremely long patterns. */
const REGEX_MAX_LENGTH = 500;

/**
 * Returns true for patterns with common catastrophic-backtracking shapes,
 * e.g. nested quantifiers like (a+)+ or (.+)*.
 * This is a best-effort guard — not comprehensive, but catches frequent cases.
 */
function hasReDoSRisk(source: string): boolean {
  // Nested quantifiers: anything like (...[+*]...)[+*] or (...)[+*]{n,}
  return /\([^()]*[+*][^()]*\)\s*[+*{]/.test(source);
}

/**
 * Builds a RegExp from user-supplied query and flags.
 * Returns null if the query is empty, the pattern is unsafe (ReDoS risk,
 * over-length, or invalid), or the regex produces only zero-length matches.
 */
export function buildSearchRegex(query: string, flags: SearchFlags): RegExp | null {
  if (!query) return null;
  try {
    const escaped = flags.regex
      ? query
      : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Guard: pattern too long
    if (escaped.length > REGEX_MAX_LENGTH) return null;

    // Guard: known ReDoS risk shapes (regex mode only; literal mode is always safe)
    if (flags.regex && hasReDoSRisk(escaped)) return null;

    const source = flags.wholeWord ? `\\b${escaped}\\b` : escaped;
    const regexFlags = flags.caseSensitive ? 'g' : 'gi';
    const re = new RegExp(source, regexFlags);

    // Guard: reject zero-length-match patterns (anchors like ^, $, lookaheads,
    // \b-only patterns, etc.) — they produce invisible marks and confuse count.
    re.lastIndex = 0;
    const probe = re.exec('_probe_string_');
    if (probe && probe[0].length === 0) return null;

    return re;
  } catch {
    return null;
  }
}

/**
 * Splits `text` into alternating non-match / match segments using `regex`.
 * Zero-length matches are silently skipped.
 */
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
    // Skip zero-length matches — they create invisible marks.
    if (match[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (match.index > lastIndex) {
      result.push({ text: text.slice(lastIndex, match.index), isMatch: false });
    }
    result.push({ text: match[0], isMatch: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    result.push({ text: text.slice(lastIndex), isMatch: false });
  }

  return result;
}
