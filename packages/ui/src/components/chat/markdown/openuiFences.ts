import { unified, type Processor } from 'unified';
import remarkParse from 'remark-parse';
import type { Root, RootContent } from 'mdast';
import type { CompileContext, Extension } from 'mdast-util-from-markdown';
import { remarkDisclosures } from './remarkDisclosures';

export interface OpenUIFence {
  start: number;
  end: number;
  code: string;
  closed: boolean;
  literal: boolean;
  meta: string | null;
}

const closedFences = new WeakSet<RootContent>();

function codeAncestor(stack: CompileContext['stack']) {
  for (let index = stack.length - 1; index >= 0; index--) {
    const node = stack[index];
    if (node.type === 'code') return node;
  }
}

const fromMarkdown: Extension = {
  enter: {
    codeFencedFence() {
      if (this.data.flowCodeInside) {
        const code = codeAncestor(this.stack);
        if (code?.lang === 'openui-lang') closedFences.add(code);
      }
    },
  },
};

function isMarkdownRoot(tree: ReturnType<Processor['parse']>): tree is Root {
  return tree.type === 'root';
}

function visit(node: Root | RootContent, fences: OpenUIFence[]): void {
  if (node.type === 'code' && node.lang === 'openui-lang') {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      const meta = node.meta ?? null;
      fences.push({
        start,
        end,
        code: node.value,
        closed: closedFences.has(node),
        literal: meta === 'literal',
        meta,
      });
    }
  }
  if ('children' in node) for (const child of node.children) visit(child, fences);
}

/**
 * Canonical fence positions are UTF-16 offsets in this normalized string.
 * The parser's code value is kept unchanged after its normal fenced-code rules.
 */
export function normalizeOpenUISource(source: string): string {
  return source.replace(/^\uFEFF/, '').replace(/\r\n?|\n/g, '\n');
}

/** Registers closure tracking while retaining remark-parse's fenced-code handlers. */
export function remarkOpenUIFenceSyntax(this: Processor): void {
  const data = this.data();
  (data.fromMarkdownExtensions ??= []).push(fromMarkdown);
}

/**
 * Collects exact-language fenced code from the shared remark parser chain.
 * It returns literal and unknown metadata for source display decisions, but does
 * not treat either form as active UI.
 */
export function collectOpenUIFences(source: string): OpenUIFence[] {
  const parser = unified().use(remarkParse).use(remarkOpenUIFenceSyntax).use(remarkDisclosures);
  const normalized = normalizeOpenUISource(source);
  const tree = parser.runSync(parser.parse(normalized), normalized);
  if (!isMarkdownRoot(tree)) throw new Error('OpenUI fence parsing requires a Markdown root');
  const fences: OpenUIFence[] = [];
  visit(tree, fences);
  return fences;
}
