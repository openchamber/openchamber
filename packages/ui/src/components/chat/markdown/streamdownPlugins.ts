import { cjk } from '@streamdown/cjk';
import { createMathPlugin } from '@streamdown/math';
import { defaultRehypePlugins, defaultRemarkPlugins, type CjkPlugin, type MathPlugin, type StreamdownProps } from 'streamdown';
import type { Pluggable, Plugin, Processor } from 'unified';
import type { Root, RootContent } from 'mdast';
import rehypeSanitize from 'rehype-sanitize';
import { remarkAlerts, MARKDOWN_ALERT_KINDS } from './remarkAlerts';
import { remarkDisclosures } from './remarkDisclosures';
import { remarkMathCompatibility } from './remarkMathCompatibility';
import { rehypeMarkdownPolicy, rehypeRestoreMarkdownLinks } from './rehypeMarkdownPolicy';
import { isInvisibleText } from '@/lib/invisibleText';

// Micromark merges GFM and CJK registrations, so both must disable single tildes.
const strictTildes = { singleTilde: false } as const;
const gfmEntry = defaultRemarkPlugins.gfm as [Plugin, Record<string, unknown>];
const defaultRemarkPluginList: Pluggable[] = [
  [gfmEntry[0], strictTildes],
  ...Object.values(defaultRemarkPlugins).filter((plugin) => plugin !== defaultRemarkPlugins.gfm),
];

// `@streamdown/cjk` is pinned to 1.0.4, which appends its strikethrough last.
const cjkStrikethrough = cjk.remarkPluginsAfter.at(-1) as Plugin;
const markdownCjk: CjkPlugin = {
  ...cjk,
  remarkPluginsAfter: [...cjk.remarkPluginsAfter.slice(0, -1), [cjkStrikethrough, strictTildes]],
};

export function getMarkdownCjk(singleTilde = false): CjkPlugin {
  return singleTilde ? cjk : markdownCjk;
}

const officialMath = createMathPlugin({ singleDollarTextMath: false });
// Streamdown appends math's remark plugin after the configured remark plugins.
// Keeping the compatibility transformer here makes it run after remark-math.
export const markdownMath: MathPlugin = {
  ...officialMath,
  remarkPlugin: function markdownMathSyntax(this: Processor) {
    this.use([officialMath.remarkPlugin]);
    return remarkMathCompatibility.call(this);
  },
};

const schema: NonNullable<Parameters<typeof rehypeSanitize>[0]> = {
  tagNames: ['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'picture', 'pre', 'q', 's', 'samp', 'section', 'source', 'span', 'strike', 'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'tt', 'ul', 'var', 'video'],
  strip: ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form'],
  attributes: {
    '*': ['align', 'alt', 'checked', 'colSpan', 'height', 'media', 'open', 'rowSpan', 'start', 'title', 'width'],
    a: ['href', 'id', 'ariaDescribedBy', 'ariaLabel', 'dataFootnoteRef', 'dataFootnoteBackref', 'dataOcLinkSource', 'dataOcReference'],
    // `:` for GitLab's suggestion fences (`suggestion:-0+2`).
    code: [['className', /^language-[\w#+.:-]+$/, 'math-inline', 'math-display'], 'metastring'],
    img: ['src', 'srcSet', 'alt', 'dataOcMediaSource'],
    source: ['src', 'srcSet', 'type', 'media', 'dataOcMediaSource'],
    video: ['src', 'controls', 'playsInline', 'preload', 'dataOcMediaSource'],
    input: ['type', 'checked', 'disabled'],
    li: [['className', 'task-list-item']],
    ul: [['className', 'contains-task-list']],
    ol: [['className', 'contains-task-list']],
    section: ['dataFootnotes', ['className', 'footnotes']],
    h2: ['id', ['className', 'sr-only']],
    blockquote: [['dataOcAlert', ...MARKDOWN_ALERT_KINDS]],
  },
  // href has already passed the application URL classifier. Media still only
  // uses HTTP(S)/relative src; local files travel as validated source metadata.
  protocols: { src: ['http', 'https'] },
  clobberPrefix: '',
  required: { input: { type: 'checkbox', disabled: true } },
};

function remarkSessionLinks() {
  return (tree: Root) => {
    function walk(node: Root | RootContent): void {
      if (!('children' in node) || node.type === 'link' || node.type === 'linkReference') return;
      const children: RootContent[] = node.children;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.type !== 'text') { walk(child); continue; }
        const matches = Array.from(child.value.matchAll(/\bopenchamber:\/\/session\/[A-Za-z0-9_-]{1,128}(?:\?message=[A-Za-z0-9_-]{1,128})?/g));
        if (matches.length === 0) continue;
        const replacement: RootContent[] = [];
        let offset = 0;
        for (const match of matches) {
          if (match.index > offset) replacement.push({ type: 'text', value: child.value.slice(offset, match.index) });
          replacement.push({ type: 'link', url: match[0], children: [{ type: 'text', value: match[0] }] });
          offset = match.index + match[0].length;
        }
        if (offset < child.value.length) replacement.push({ type: 'text', value: child.value.slice(offset) });
        children.splice(i, 1, ...replacement);
        i += replacement.length - 1;
      }
    }
    walk(tree);
  };
}

// Static mode parses the whole document without the streaming BlockComponent.
// Match the original top-level source policy without stripping inline joiners.
function remarkVisibleBlocks() {
  return (tree: Root, file: { value: string | Uint8Array }) => {
    // Micromark omits a leading BOM before assigning source offsets.
    const source = String(file.value).replace(/^\uFEFF/, '');
    tree.children = tree.children.filter((node) => {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      return start === undefined || end === undefined || !isInvisibleText(source.slice(start, end));
    });
  };
}

function createOptions(allowRawHtml: boolean, isVSCode: boolean, singleTilde: boolean): Pick<StreamdownProps, 'remarkPlugins' | 'rehypePlugins'> {
  return {
    remarkPlugins: [...(singleTilde ? Object.values(defaultRemarkPlugins) : defaultRemarkPluginList), remarkDisclosures, remarkAlerts, remarkVisibleBlocks, remarkSessionLinks],
    rehypePlugins: [
      ...(allowRawHtml ? [defaultRehypePlugins.raw] : []),
      [rehypeMarkdownPolicy, { isVSCode }],
      [rehypeSanitize, schema],
      defaultRehypePlugins.harden,
      rehypeRestoreMarkdownLinks,
    ],
  };
}
const policies = [false, true].flatMap(singleTilde => [
  createOptions(false, false, singleTilde), createOptions(false, true, singleTilde),
  createOptions(true, false, singleTilde), createOptions(true, true, singleTilde),
]);
export function getMarkdownProcessingOptions(allowRawHtml: boolean, isVSCode: boolean, singleTilde = false): Pick<StreamdownProps, 'remarkPlugins' | 'rehypePlugins'> {
  return policies[(singleTilde ? 4 : 0) + (allowRawHtml ? 2 : 0) + (isVSCode ? 1 : 0)];
}
