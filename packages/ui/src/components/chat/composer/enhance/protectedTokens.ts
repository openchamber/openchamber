/**
 * Syntax guard for the Enhance Prompt rewrite.
 *
 * The composer's prompt language is not plain prose: `@mentions`, `/commands`
 * and `#snippets` are live references the send path resolves. The Small Model
 * rewriting the draft knows none of that, so its output is checked before it
 * replaces the draft.
 *
 * The guard protects corruption, not creativity. A model that drops a token
 * the user typed has corrupted a reference the send path would silently
 * mis-resolve; a model that invents `@file`, `/command` or `#snippet`
 * references out of thin air would land them in the prompt as if the user had
 * written them. The whole guard is one policy: every source token must
 * survive, and no token of any kind may be invented. The model may rephrase
 * everything around the tokens and move them anywhere in the text — position
 * and order are unconstrained.
 *
 * Scanning is deliberately the same as the editor's: `scanMentions` and
 * `scanPrefixTokens` are the single source of truth for where tokens are, so
 * the guard cannot drift from what the composer actually highlights.
 */

import { scanMentions } from '../language/mentions';
import { scanPrefixTokens, type TokenPrefix } from '../language/prefixTokens';
import type { ComposerLanguageContext } from '../language/tokenize';

export interface ProtectedTokens {
  /** `@` mention names, e.g. `path/to/file.ts` or `AgentName` — the punctuation-brushed core, without `@`. */
  mentions: string[];
  /** `@`-free `/` tokens with the sigil — commands and skills, e.g. `/review`. */
  slash: string[];
  /** `@`-free `#` tokens with the sigil — snippets, e.g. `#notes`. */
  snippets: string[];
}

interface ProtectedTokenRule {
  /** Compare token text case-insensitively (mirrors `filterKnownTokens`'s default). */
  caseInsensitive: boolean;
}

/**
 * Every kind shares one policy — source tokens must survive, none may be
 * invented — so the only per-kind difference left is case sensitivity.
 */
const RULES = {
  mention: { caseInsensitive: false },
  '/': { caseInsensitive: true },
  '#': { caseInsensitive: false },
} as const satisfies Record<TokenPrefix | 'mention', ProtectedTokenRule>;

/**
 * Every protected token in `text`, deduplicated: mentions via the mention
 * grammar, slash and snippet tokens via the prefix-token scanner. The context
 * keeps the guard's interface aligned with the editor's language context so
 * Stage B can pass the same object it already holds; the extraction itself
 * only needs the scanners — membership in the known sets is deliberately not
 * consulted, so tokens the composer has not yet resolved are still protected.
 */
// SAFETY: the parameter is part of the guard's public signature; it exists so
// callers pass the same context object the editor already holds.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function extractProtectedTokens(text: string, _context: ComposerLanguageContext): ProtectedTokens {
  // Mentions compare by `name` — the punctuation-brushed core the editor
  // resolves — not `raw`: the model's rewrite legitimately re-punctuates
  // around a mention ("@src/app.ts," → "@src/app.ts"), and comparing raw
  // spans would read that drift as a lost token.
  const mentions = [...new Set(scanMentions(text).map((token) => token.name))];
  const slash = [...new Set(scanPrefixTokens(text, '/').map((token) => text.slice(token.start, token.end)))];
  const snippets = [...new Set(scanPrefixTokens(text, '#').map((token) => text.slice(token.start, token.end)))];
  return { mentions, slash, snippets };
}

const normalizeKey = (token: string, caseInsensitive: boolean): string =>
  caseInsensitive ? token.toLowerCase() : token;

/**
 * True when the rewrite preserved every protected token.
 *
 * The policy is identical for all three kinds: the source tokens must all
 * appear in the result, and the result must not introduce tokens the source
 * did not have. A list the source does not use imposes no preservation
 * requirement on it, but the result may not add tokens to it either.
 */
export function validateProtectedTokensPreserved(
  source: string,
  result: string,
  context: ComposerLanguageContext,
): boolean {
  const sourceTokens = extractProtectedTokens(source, context);
  const resultTokens = extractProtectedTokens(result, context);

  const pairs: Array<[string[], string[], ProtectedTokenRule]> = [
    [sourceTokens.mentions, resultTokens.mentions, RULES.mention],
    [sourceTokens.slash, resultTokens.slash, RULES['/']],
    [sourceTokens.snippets, resultTokens.snippets, RULES['#']],
  ];

  for (const [expected, actual, rule] of pairs) {
    const actualKeys = new Set(actual.map((token) => normalizeKey(token, rule.caseInsensitive)));
    for (const token of expected) {
      if (!actualKeys.has(normalizeKey(token, rule.caseInsensitive))) {
        return false;
      }
    }
    if (actual.length > expected.length) {
      // Deduplicated lists, so any surplus is a token the source did not
      // have — invented, and forbidden for every kind.
      return false;
    }
  }

  return true;
}
