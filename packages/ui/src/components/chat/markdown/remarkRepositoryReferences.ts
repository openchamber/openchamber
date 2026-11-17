import type { Link, PhrasingContent, Root, RootContent } from 'mdast';

import { splitProjectPath } from '@/lib/source-control/projectPath';
import {
  repositoryCommitLink,
  repositoryItemLink,
  repositoryUserLink,
  type RepositoryLinkContext,
} from '@/lib/source-control/repositoryLinks';

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const referencePattern = (context: RepositoryLinkContext): RegExp => {
  const { issuePrefix, changeRequestPrefix } = context.descriptor.terminology;
  const prefixes = [...new Set([issuePrefix, changeRequestPrefix])].sort((a, b) => b.length - a.length).map(escape).join('|');
  return new RegExp([
    String.raw`(?<![\w/#!@&.-])(?<project>[\w.-]+(?:/[\w.-]+)+)?(?<prefix>${prefixes})(?<number>\d+)(?![\w-])`,
    String.raw`(?<![\w@./+-])@(?<user>[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)(?![\w@/-])`,
    String.raw`(?<![\w/@#.-])(?<sha>[0-9a-f]{7,40})(?![\w/-])`,
  ].join('|'), 'g');
};

type Found = { url: string; children: PhrasingContent[] };

const linkFor = (context: RepositoryLinkContext, groups: Record<string, string | undefined>, text: string): Found | null => {
  const { issuePrefix, changeRequestPrefix } = context.descriptor.terminology;
  if (groups.number && groups.prefix) {
    const kind = groups.prefix === issuePrefix ? 'issue' : groups.prefix === changeRequestPrefix ? 'pull' : null;
    const number = Number(groups.number);
    if (!kind || !Number.isSafeInteger(number) || number < 1) return null;
    if (groups.project && !context.descriptor.repository.nestedNamespaces && groups.project.split('/').length > 2) return null;
    const url = repositoryItemLink(context, kind, number, groups.project ? splitProjectPath(groups.project) : context);
    return url ? { url, children: [{ type: 'text', value: text }] } : null;
  }
  if (groups.user) {
    const url = repositoryUserLink(context, groups.user);
    return url ? { url, children: [{ type: 'text', value: text }] } : null;
  }
  if (groups.sha && /\d/.test(groups.sha) && /[a-f]/.test(groups.sha)) {
    const url = repositoryCommitLink(context, groups.sha);
    return url ? { url, children: [{ type: 'inlineCode', value: groups.sha.slice(0, 7) }] } : null;
  }
  return null;
};

const rawTagDepth = (html: string): number => {
  let depth = 0;
  for (const tag of html.matchAll(/<(\/?)(a|code)\b[^>]*?(\/?)>/gi)) {
    if (tag[3]) continue;
    depth += tag[1] ? -1 : 1;
  }
  return depth;
};

const SKIPPED: ReadonlySet<string> = new Set(['link', 'linkReference', 'inlineCode', 'code', 'html', 'definition', 'math', 'inlineMath']);

export function remarkRepositoryReferences(context: RepositoryLinkContext) {
  const pattern = referencePattern(context);
  const split = (value: string): PhrasingContent[] | null => {
    const parts: PhrasingContent[] = [];
    let offset = 0;
    for (const match of value.matchAll(pattern)) {
      const found = match.groups ? linkFor(context, match.groups, match[0]) : null;
      if (!found) continue;
      if (match.index > offset) parts.push({ type: 'text', value: value.slice(offset, match.index) });
      const link: Link = { type: 'link', url: found.url, children: found.children, data: { hProperties: { dataOcReference: '' } } };
      parts.push(link);
      offset = match.index + match[0].length;
    }
    if (parts.length === 0) return null;
    if (offset < value.length) parts.push({ type: 'text', value: value.slice(offset) });
    return parts;
  };
  return (tree: Root) => {
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
