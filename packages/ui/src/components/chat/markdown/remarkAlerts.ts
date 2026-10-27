import type { Properties } from 'hast';
import type { Blockquote, Root, RootContent } from 'mdast';

export const MARKDOWN_ALERT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type MarkdownAlertKind = typeof MARKDOWN_ALERT_KINDS[number];

/** The kind a marker or a rendered quote's `data-oc-alert` names; null for anything else. */
export const markdownAlertKind = (value: Properties[string]): MarkdownAlertKind | null =>
  MARKDOWN_ALERT_KINDS.find((kind) => kind === value) ?? null;

// GitHub's marker stands alone on the quote's first line: `> [!NOTE]`.
const marker = /^\[!(note|tip|important|warning|caution)\][\t ]*(?:\r?\n|$)/i;

function toAlert(quote: Blockquote): void {
  const first = quote.children[0];
  if (first?.type !== 'paragraph') return;
  const text = first.children[0];
  if (text?.type !== 'text') return;
  const match = marker.exec(text.value);
  const kind = markdownAlertKind(match?.[1].toLowerCase());
  if (!match || !kind) return;
  text.value = text.value.slice(match[0].length);
  if (!text.value) first.children.shift();
  // A soft break right after the marker leaves the paragraph starting blank.
  const next = first.children[0];
  if (next?.type === 'break') first.children.shift();
  if (first.children.length === 0) quote.children.shift();
  quote.data = { ...quote.data, hProperties: { ...quote.data?.hProperties, dataOcAlert: kind } };
}

/**
 * GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`,
 * `[!CAUTION]`): the quote loses its marker and carries the kind, which the
 * blockquote component draws as a titled callout.
 */
export function remarkAlerts() {
  return (tree: Root) => {
    const walk = (node: Root | RootContent): void => {
      if (node.type === 'blockquote') toAlert(node);
      if ('children' in node) for (const child of node.children) walk(child);
    };
    walk(tree);
  };
}
