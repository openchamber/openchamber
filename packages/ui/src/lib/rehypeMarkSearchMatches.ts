/**
 * rehypeMarkSearchMatches — wraps text matching a search query in
 * <mark data-search-match data-search-msg="messageId"> elements.
 */

import { buildSearchRegex } from './splitByHighlight';
import type { SearchFlags } from '@/stores/useChatSearchStore';

export interface RehypeMarkSearchMatchesOptions {
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  isRegex: boolean;
  messageId: string;
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

// ── Block-level tag set ───────────────────────────────────────────────────────

const BLOCK_TAG_NAMES = new Set([
  'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'blockquote', 'pre', 'table',
  'thead', 'tbody', 'tr', 'td', 'th',
]);

function isBlockElement(child: HastChild): boolean {
  return child.type === 'element' && BLOCK_TAG_NAMES.has((child as HastElement).tagName);
}

// ── flattenInlineChildren (module-level — no messageId dependency) ────────────

function flattenInlineChildren(children: HastChild[]): {
  text: string;
  segments: Array<{
    node: HastChild;
    start: number;
    end: number;
    text: string;
    childIndex: number;
  }>;
} {
  let text = '';
  const segments: Array<{
    node: HastChild; start: number; end: number; text: string; childIndex: number;
  }> = [];

  function walk(node: HastChild, childIndex: number) {
    if (node.type === 'text') {
      const t = node as HastText;
      segments.push({ node, start: text.length, end: text.length + t.value.length, text: t.value, childIndex });
      text += t.value;
    } else if (node.type === 'element') {
      const el = node as HastElement;
      if (el.tagName === 'pre') return;
      for (const child of el.children) walk(child, childIndex);
    }
  }

  for (let i = 0; i < children.length; i++) {
    walk(children[i], i);
  }

  return { text, segments };
}

// ── plugin factory ────────────────────────────────────────────────────────────

function rehypeMarkSearchMatches(options: RehypeMarkSearchMatchesOptions) {
  return (tree: HastRoot): void => {
    const flags: SearchFlags = {
      caseSensitive: options.caseSensitive,
      wholeWord: options.wholeWord,
      regex: options.isRegex,
    };
    const regex = buildSearchRegex(options.query, flags);
    if (!regex) return;

    const { messageId } = options;

    // ── helpers that close over messageId ──────────────────────────────────

    function makeMarkNode(text: string): HastElement {
      return {
        type: 'element',
        tagName: 'mark',
        properties: { 'data-search-match': true, 'data-search-msg': messageId },
        children: [{ type: 'text', value: text }],
      };
    }

    function splitNode(node: HastText, re: RegExp): HastChild[] {
      const text = node.value;
      const parts: HastChild[] = [];
      let lastIndex = 0;
      const localRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
      localRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = localRe.exec(text)) !== null) {
        if (match[0].length === 0) { localRe.lastIndex++; continue; }
        if (match.index > lastIndex) parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
        parts.push(makeMarkNode(match[0]));
        lastIndex = match.index + match[0].length;
      }
      if (parts.length === 0) return [node];
      if (lastIndex < text.length) parts.push({ type: 'text', value: text.slice(lastIndex) });
      return parts;
    }

    function containsMark(node: HastChild): boolean {
      if (node.type === 'element') {
        const el = node as HastElement;
        if (el.tagName === 'mark') return true;
        return el.children.some(containsMark);
      }
      return false;
    }

    function transformChildren(children: HastChild[]): HastChild[] {
      const result: HastChild[] = [];
      let inlineBuffer: HastChild[] = [];

      const flushBuffer = () => {
        if (inlineBuffer.length > 0) {
          result.push(...transformInlineSequence(inlineBuffer));
          inlineBuffer = [];
        }
      };

      for (const child of children) {
        if (isBlockElement(child)) {
          flushBuffer();
          const el = child as HastElement;
          if (el.tagName === 'pre') {
            result.push(el);
          } else {
            result.push({ ...el, children: transformChildren(el.children) });
          }
        } else {
          inlineBuffer.push(child);
        }
      }

      flushBuffer();
      return result;
    }

    function transformInlineSequence(children: HastChild[]): HastChild[] {
      const normalResult = children.flatMap((child) => {
        if (child.type === 'text') return splitNode(child as HastText, regex!);
        if (child.type === 'element') {
          const el = child as HastElement;
          if (el.tagName === 'pre') return [el];
          return [{ ...el, children: transformChildren(el.children) }];
        }
        return [child];
      });

      if (normalResult.some(containsMark)) return normalResult;

      // Cross-boundary search
      const { text: flatText, segments } = flattenInlineChildren(children);
      if (flatText.length === 0) return normalResult;

      const re = new RegExp(regex!.source, regex!.flags.includes('g') ? regex!.flags : regex!.flags + 'g');
      re.lastIndex = 0;
      const crossMatches: Array<{ start: number; end: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(flatText)) !== null) {
        if (m[0].length === 0) { re.lastIndex++; continue; }
        crossMatches.push({ start: m.index, end: m.index + m[0].length });
      }
      if (crossMatches.length === 0) return normalResult;

      let minChildIdx = Infinity;
      let maxChildIdx = -Infinity;
      for (const match of crossMatches) {
        for (const seg of segments) {
          if (seg.start < match.end && seg.end > match.start) {
            if (seg.childIndex < minChildIdx) minChildIdx = seg.childIndex;
            if (seg.childIndex > maxChildIdx) maxChildIdx = seg.childIndex;
          }
        }
      }
      if (minChildIdx === Infinity) return normalResult;

      const regionChildren = children.slice(minChildIdx, maxChildIdx + 1);
      const { text: regionText } = flattenInlineChildren(regionChildren);

      const re2 = new RegExp(regex!.source, regex!.flags.includes('g') ? regex!.flags : regex!.flags + 'g');
      re2.lastIndex = 0;
      const regionResult: HastChild[] = [];
      let lastIdx = 0;
      let rm: RegExpExecArray | null;
      while ((rm = re2.exec(regionText)) !== null) {
        if (rm[0].length === 0) { re2.lastIndex++; continue; }
        if (rm.index > lastIdx) regionResult.push({ type: 'text', value: regionText.slice(lastIdx, rm.index) });
        regionResult.push(makeMarkNode(rm[0]));
        lastIdx = rm.index + rm[0].length;
      }
      if (lastIdx < regionText.length) regionResult.push({ type: 'text', value: regionText.slice(lastIdx) });

      return [
        ...normalResult.slice(0, minChildIdx),
        ...regionResult,
        ...normalResult.slice(maxChildIdx + 1),
      ];
    }

    // ── Transform tree ────────────────────────────────────────────────────

    tree.children = transformChildren(tree.children);
  };
}

export default rehypeMarkSearchMatches;
