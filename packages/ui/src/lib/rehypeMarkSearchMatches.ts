/**
 * Search highlighting shared by the markdown tree tests and the live DOM
 * renderer. A logical match can span several inline text nodes; every
 * resulting fragment keeps the same occurrence number.
 */

import { buildSearchRegex } from './splitByHighlight';
import type { SearchContext, SearchFlags } from '@/stores/useChatSearchStore';

export interface RehypeMarkSearchMatchesOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  messageId: string;
  partId?: string;
  partType?: 'text' | 'reasoning';
}

export interface SearchMatchFragment {
  segmentIndex: number;
  start: number;
  end: number;
  occurrence: number;
}

/**
 * Finds all match fragments in a sequence of inline text segments.
 *
 * The regex is executed once against the concatenated sequence, rather than
 * once per segment. This preserves both ordinary matches and matches that
 * cross an inline element boundary, while assigning one stable occurrence ID
 * to every fragment of a logical match.
 */
export const findSegmentMatchFragments = (
  segments: readonly string[],
  regex: RegExp,
  occurrenceOffset = 0,
): SearchMatchFragment[] => {
  const text = segments.join('');
  if (!text) {
    return [];
  }

  const boundaries: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const segment of segments) {
    boundaries.push({ start: offset, end: offset + segment.length });
    offset += segment.length;
  }

  const matcher = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  matcher.lastIndex = 0;

  const fragments: SearchMatchFragment[] = [];
  let occurrence = occurrenceOffset;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(text)) !== null) {
    const matchText = match[0];
    if (matchText.length === 0) {
      matcher.lastIndex += 1;
      continue;
    }

    const matchStart = match.index;
    const matchEnd = matchStart + matchText.length;
    boundaries.forEach((boundary, segmentIndex) => {
      const start = Math.max(matchStart, boundary.start);
      const end = Math.min(matchEnd, boundary.end);
      if (start >= end) {
        return;
      }

      fragments.push({
        segmentIndex,
        start: start - boundary.start,
        end: end - boundary.start,
        occurrence,
      });
    });
    occurrence += 1;
  }

  return fragments;
};

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

// ── Block-level tag set ──────────────────────────────────────────────────────

const BLOCK_TAG_NAMES = new Set([
  'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'table',
  'thead', 'tbody', 'tr', 'td', 'th', 'dl', 'dt', 'dd',
]);

const isBlockElement = (child: HastChild): child is HastElement => (
  child.type === 'element' && 'tagName' in child && BLOCK_TAG_NAMES.has(child.tagName)
);

const flattenInlineChildren = (children: HastChild[]): {
  text: string;
  segments: Array<{ node: HastChild; text: string; segmentIndex: number }>;
} => {
  let text = '';
  const segments: Array<{ node: HastChild; text: string; segmentIndex: number }> = [];

  const walk = (node: HastChild) => {
    if (node.type === 'text') {
      const value = (node as HastText).value;
      segments.push({ node, text: value, segmentIndex: segments.length });
      text += value;
      return;
    }

    if (node.type !== 'element' || (node as HastElement).tagName === 'pre') {
      return;
    }

    (node as HastElement).children.forEach(walk);
  };

  children.forEach(walk);
  return { text, segments };
};

const searchProperties = (options: RehypeMarkSearchMatchesOptions, occurrence: number): Record<string, unknown> => ({
  'data-search-match': true,
  'data-search-msg': options.messageId,
  ...(options.partId ? { 'data-search-part': options.partId } : {}),
  ...(options.partType ? { 'data-search-part-type': options.partType } : {}),
  'data-search-occurrence': occurrence,
});

const makeHastMark = (
  value: string,
  options: RehypeMarkSearchMatchesOptions,
  occurrence: number,
): HastElement => ({
  type: 'element',
  tagName: 'mark',
  properties: searchProperties(options, occurrence),
  children: [{ type: 'text', value }],
});

const applyHastFragments = (
  node: HastChild,
  segments: Array<{ node: HastChild; text: string; segmentIndex: number }>,
  fragments: readonly SearchMatchFragment[],
  options: RehypeMarkSearchMatchesOptions,
): HastChild[] => {
  if (node.type === 'text') {
    const segment = segments.find((candidate) => candidate.node === node);
    if (!segment) {
      return [node];
    }

    const nodeFragments = fragments.filter((fragment) => fragment.segmentIndex === segment.segmentIndex);
    if (nodeFragments.length === 0) {
      return [node];
    }

    const result: HastChild[] = [];
    let cursor = 0;
    for (const fragment of nodeFragments) {
      if (fragment.start > cursor) {
        result.push({ type: 'text', value: (node as HastText).value.slice(cursor, fragment.start) });
      }
      result.push(makeHastMark((node as HastText).value.slice(fragment.start, fragment.end), options, fragment.occurrence));
      cursor = fragment.end;
    }
    const textNode = node as HastText;
    if (cursor < textNode.value.length) {
      result.push({ type: 'text', value: textNode.value.slice(cursor) });
    }
    return result;
  }

  if (node.type !== 'element' || (node as HastElement).tagName === 'pre') {
    return [node];
  }

  const element = node as HastElement;
  const nextChildren = element.children.flatMap((child) => (
    applyHastFragments(child, segments, fragments, options)
  ));
  return [{ ...element, children: nextChildren }];
};

/**
 * Mark a HAST tree. This remains available for callers that render markdown
 * through a tree pipeline; the current renderer uses the DOM helper below.
 */
function rehypeMarkSearchMatches(options: RehypeMarkSearchMatchesOptions) {
  return (tree: HastRoot): void => {
    const flags: SearchFlags = {
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      regex: options.isRegex,
    };
    const regex = buildSearchRegex(options.query, flags);
    if (!regex) {
      return;
    }

    const transformChildren = (
      children: HastChild[],
      occurrenceState: { value: number },
    ): HastChild[] => {
      const result: HastChild[] = [];
      let inlineBuffer: HastChild[] = [];

      const flushInlineBuffer = () => {
        if (inlineBuffer.length === 0) {
          return;
        }

        const { segments } = flattenInlineChildren(inlineBuffer);
        const fragments = findSegmentMatchFragments(
          segments.map((segment) => segment.text),
          regex,
          occurrenceState.value,
        );
        if (fragments.length > 0) {
          occurrenceState.value = Math.max(...fragments.map((fragment) => fragment.occurrence + 1));
        }
        result.push(...(
          fragments.length === 0
            ? inlineBuffer
            : inlineBuffer.flatMap((child) => applyHastFragments(child, segments, fragments, options))
        ));
        inlineBuffer = [];
      };

      for (const child of children) {
        if (!isBlockElement(child)) {
          inlineBuffer.push(child);
          continue;
        }

        flushInlineBuffer();
        if (child.tagName === 'pre') {
          result.push(child);
        } else {
          result.push({ ...child, children: transformChildren(child.children, occurrenceState) });
        }
      }

      flushInlineBuffer();
      return result;
    };

    tree.children = transformChildren(tree.children, { value: 0 });
  };
}

// ── Current marked/morphdom renderer boundary ────────────────────────────────

const SEARCH_MARK_SELECTOR = 'mark[data-search-match]';

const clearSearchMarks = (container: HTMLElement): void => {
  const marks = Array.from(container.querySelectorAll<HTMLElement>(SEARCH_MARK_SELECTOR));
  for (const mark of marks) {
    mark.replaceWith(...Array.from(mark.childNodes));
  }
  container.normalize();
};

interface DomTextSegment {
  node: Text;
  text: string;
}

const collectDomTextSequences = (container: HTMLElement): DomTextSegment[][] => {
  const sequences: DomTextSegment[][] = [];
  let current: DomTextSegment[] = [];

  const flush = () => {
    if (current.length > 0) {
      sequences.push(current);
      current = [];
    }
  };

  const visitChildren = (parent: Node) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 3) {
        const text = child.nodeValue ?? '';
        if (text.length > 0) {
          current.push({ node: child as Text, text });
        }
        continue;
      }

      if (child.nodeType !== 1) {
        continue;
      }

      const element = child as HTMLElement;
      const tagName = element.tagName.toLowerCase();
      if (tagName === 'pre') {
        flush();
        continue;
      }
      if (tagName === 'br') {
        flush();
        continue;
      }
      if (BLOCK_TAG_NAMES.has(tagName)) {
        flush();
        visitChildren(element);
        flush();
        continue;
      }

      visitChildren(element);
    }
  };

  visitChildren(container);
  flush();
  return sequences;
};

const applyDomFragments = (
  segment: DomTextSegment,
  fragments: readonly SearchMatchFragment[],
  options: RehypeMarkSearchMatchesOptions,
): void => {
  if (fragments.length === 0 || !segment.node.parentNode) {
    return;
  }

  const document = segment.node.ownerDocument;
  const output = document.createDocumentFragment();
  let cursor = 0;
  for (const fragment of fragments) {
    if (fragment.start > cursor) {
      output.appendChild(document.createTextNode(segment.text.slice(cursor, fragment.start)));
    }

    const mark = document.createElement('mark');
    mark.setAttribute('data-search-match', 'true');
    mark.setAttribute('data-search-msg', options.messageId);
    if (options.partId) {
      mark.setAttribute('data-search-part', options.partId);
    }
    if (options.partType) {
      mark.setAttribute('data-search-part-type', options.partType);
    }
    mark.setAttribute('data-search-occurrence', String(fragment.occurrence));
    mark.textContent = segment.text.slice(fragment.start, fragment.end);
    output.appendChild(mark);
    cursor = fragment.end;
  }

  if (cursor < segment.text.length) {
    output.appendChild(document.createTextNode(segment.text.slice(cursor)));
  }
  segment.node.replaceWith(output);
};

export const applySearchHighlights = (
  container: HTMLElement,
  searchContext?: SearchContext,
): void => {
  clearSearchMarks(container);
  if (!searchContext) {
    return;
  }

  const flags: SearchFlags = {
    caseSensitive: searchContext.caseSensitive,
    wholeWord: searchContext.wholeWord,
    regex: searchContext.isRegex,
  };
  const regex = buildSearchRegex(searchContext.query, flags);
  if (!regex) {
    return;
  }

  const options: RehypeMarkSearchMatchesOptions = {
    ...searchContext,
    messageId: searchContext.messageId,
    partId: searchContext.partId,
    partType: searchContext.partType,
  };

  let occurrenceOffset = 0;
  for (const sequence of collectDomTextSequences(container)) {
    const fragments = findSegmentMatchFragments(
      sequence.map((segment) => segment.text),
      regex,
      occurrenceOffset,
    );
    if (fragments.length > 0) {
      occurrenceOffset = Math.max(...fragments.map((fragment) => fragment.occurrence + 1));
    }
    sequence.forEach((segment, segmentIndex) => {
      applyDomFragments(
        segment,
        fragments.filter((fragment) => fragment.segmentIndex === segmentIndex),
        options,
      );
    });
  }
};

export default rehypeMarkSearchMatches;
