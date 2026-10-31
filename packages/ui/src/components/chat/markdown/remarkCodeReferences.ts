import type { Link, PhrasingContent, Root, RootContent } from 'mdast';

import { isFilePathWithinDirectory, toAbsoluteFilePath } from '@/lib/path-utils';
import { splitCodeReferences } from '@/lib/trackers/codeReferences';

import { rawTagDepth } from './remarkRepositoryReferences';

const SKIPPED: ReadonlySet<string> = new Set(['link', 'linkReference', 'inlineCode', 'code', 'html', 'definition', 'math', 'inlineMath']);

/** What a code-reference link carries; `MarkdownLink` reads these back to open the file. */
export type CodeReferenceLinkProperties = {
  dataOcCodeRef: string;
  dataOcCodeRefDir: string;
  dataOcCodeRefLine?: string;
};

/**
 * Links the code references (`src/app.ts:42`) in an item's text to the files
 * they name. Each link carries the resolved absolute path, the folder it
 * resolves against and the line number, which `MarkdownLink` opens with the
 * app's file-open action; a path that resolves outside the folder stays text.
 * Like the repository references, the links draw as part of the text, and
 * fenced blocks, code spans, links and an author's raw HTML keep their own.
 */
export function remarkCodeReferences(directory: string) {
  const split = (value: string): PhrasingContent[] | null => {
    const segments = splitCodeReferences(value);
    if (!segments) return null;
    const parts: PhrasingContent[] = [];
    for (const segment of segments) {
      if (segment.kind === 'text') {
        parts.push({ type: 'text', value: segment.value });
        continue;
      }
      const reference = segment.reference;
      const path = toAbsoluteFilePath(directory, reference.filePath);
      if (!path || !isFilePathWithinDirectory(path, directory)) {
        parts.push({ type: 'text', value: reference.text });
        continue;
      }
      const properties: CodeReferenceLinkProperties = { dataOcCodeRef: path, dataOcCodeRefDir: directory };
      if (reference.line !== null) properties.dataOcCodeRefLine = String(reference.line);
      const link: Link = {
        type: 'link',
        url: reference.filePath,
        children: [{ type: 'inlineCode', value: reference.text }],
        data: { hProperties: properties },
      };
      parts.push(link);
    }
    return parts;
  };
  return (tree: Root) => {
    const walk = (node: Root | RootContent): void => {
      if (SKIPPED.has(node.type) || !('children' in node)) return;
      const children: RootContent[] = node.children;
      // Text between an author's inline `<a …>` or `<code>` and its closing
      // tag is theirs: a link there would nest one anchor in another.
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
