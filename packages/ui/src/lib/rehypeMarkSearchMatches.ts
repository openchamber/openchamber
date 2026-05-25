/**
 * rehypeMarkSearchMatches — wraps text matching a search query in
 * <mark data-search-match> elements throughout the HAST tree.
 *
 * Types for HAST nodes are defined inline to avoid depending on the `hast`
 * and `unified` npm packages at the TypeScript level. They are transitive
 * dependencies of react-markdown and will be present at runtime.
 */

import { buildSearchRegex } from './splitByHighlight';
import type { SearchFlags } from '@/stores/useChatSearchStore';

export interface RehypeMarkSearchMatchesOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
}

// ── Minimal inline HAST type definitions ─────────────────────────────────────

interface HastText {
  type: 'text';
  value: string;
}

interface HastElement {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastChild[];
}

type HastChild = HastText | HastElement | { type: string };

interface HastRoot {
  type: 'root';
  children: HastChild[];
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Splits a HAST text node into text nodes and <mark> elements at match
 * boundaries. Returns the original single-item array when no matches.
 */
function splitHastTextNode(node: HastText, regex: RegExp): HastChild[] {
  const text = node.value;
  const parts: HastChild[] = [];
  let lastIndex = 0;

  const re = new RegExp(
    regex.source,
    regex.flags.includes('g') ? regex.flags : regex.flags + 'g',
  );
  re.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    // Skip zero-length matches — they produce invisible marks.
    if (match[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (match.index > lastIndex) {
      parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
    }
    const mark: HastElement = {
      type: 'element',
      tagName: 'mark',
      properties: { 'data-search-match': true },
      children: [{ type: 'text', value: match[0] }],
    };
    parts.push(mark);
    lastIndex = match.index + match[0].length;
  }

  if (parts.length === 0) return [node]; // no matches

  if (lastIndex < text.length) {
    parts.push({ type: 'text', value: text.slice(lastIndex) });
  }

  return parts;
}

/**
 * Recursively transforms HAST node children, splitting text nodes at match
 * boundaries and inserting <mark> elements.
 *
 * Only <pre> subtrees (fenced code blocks rendered by SyntaxHighlighter) are
 * skipped — injecting <mark> nodes into the string that SyntaxHighlighter
 * receives would corrupt its output.  Inline <code> elements ARE traversed so
 * that searches like `showPredValues` are highlighted in prose.
 */
function transformChildren(children: HastChild[], regex: RegExp): HastChild[] {
  return children.flatMap((child) => {
    if (child.type === 'text') {
      return splitHastTextNode(child as HastText, regex);
    }
    if (child.type === 'element') {
      const el = child as HastElement;
      if (el.tagName === 'pre') {
        return [el]; // skip fenced code blocks — content goes to SyntaxHighlighter
      }
      return [{ ...el, children: transformChildren(el.children, regex) }];
    }
    return [child];
  });
}

// ── plugin factory ────────────────────────────────────────────────────────────

/**
 * Returns a rehype plugin function that adds <mark data-search-match> around
 * every occurrence of the query in the rendered text.
 *
 * Usage with react-markdown:
 *   rehypePlugins={[[rehypeMarkSearchMatches, { query, caseSensitive, wholeWord, isRegex }]]}
 */
function rehypeMarkSearchMatches(options: RehypeMarkSearchMatchesOptions) {
  return (tree: HastRoot): void => {
    const flags: SearchFlags = {
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      regex: options.isRegex,
    };
    const regex = buildSearchRegex(options.query, flags);
    if (!regex) return;

    tree.children = transformChildren(tree.children, regex);
  };
}

export default rehypeMarkSearchMatches;
