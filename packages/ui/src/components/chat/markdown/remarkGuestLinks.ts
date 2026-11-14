import type { Link, PhrasingContent, Root, RootContent } from 'mdast';

import { claimGuestIdentifier, guestIdentifierPattern, type GuestLinkRule } from '@/lib/guests/links';

/** How an inline HTML node opens (+1) or closes (-1) an author's link or code span. */
const rawTagDepth = (html: string): number => {
  let depth = 0;
  for (const tag of html.matchAll(/<(\/?)(a|code)\b[^>]*?(\/?)>/gi)) {
    if (tag[3]) continue;
    depth += tag[1] ? -1 : 1;
  }
  return depth;
};

const SKIPPED: ReadonlySet<string> = new Set(['link', 'linkReference', 'inlineCode', 'code', 'html', 'definition', 'math', 'inlineMath']);

/**
 * Marks identifiers an active extension claims (`DEMO-12`) in chat text, the
 * way `remarkRepositoryReferences` links a host's references: code, existing
 * links and words stay text. The mark is a link with no URL and
 * `data-oc-guest-link` naming the extension, an attribute only this parser
 * can set (`rehypeMarkdownPolicy`); `MarkdownLink` draws it and decides the
 * click, so no file, anchor or browser route ever sees it.
 */
export function remarkGuestLinks(rules: readonly GuestLinkRule[]) {
  const pattern = guestIdentifierPattern(rules);
  const split = (value: string): PhrasingContent[] | null => {
    if (!pattern) return null;
    const parts: PhrasingContent[] = [];
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      const claim = claimGuestIdentifier(rules, match[0]);
      if (!claim) continue;
      if (match.index > offset) parts.push({ type: 'text', value: value.slice(offset, match.index) });
      const link: Link = { type: 'link', url: '', children: [{ type: 'text', value: match[0] }], data: { hProperties: { dataOcGuestLink: claim.guestId } } };
      parts.push(link);
      offset = match.index + match[0].length;
    }
    if (parts.length === 0) return null;
    if (offset < value.length) parts.push({ type: 'text', value: value.slice(offset) });
    return parts;
  };
  return (tree: Root) => {
    if (!pattern) return;
    const walk = (node: Root | RootContent): void => {
      if (SKIPPED.has(node.type) || !('children' in node)) return;
      const children: RootContent[] = node.children;
      let rawDepth = 0;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.type === 'html') { rawDepth = Math.max(0, rawDepth + rawTagDepth(child.value)); continue; }
        if (rawDepth > 0) continue;
        if (child.type !== 'text') { walk(child); continue; }
        const parts = split(child.value);
        if (!parts) continue;
        children.splice(i, 1, ...parts);
        i += parts.length - 1;
      }
    };
    walk(tree);
  };
}
