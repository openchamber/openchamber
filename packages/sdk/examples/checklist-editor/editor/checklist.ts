// The document model: a Markdown file whose `- [ ]` / `- [x]` lines are the
// checklist. Every other line is kept as it is, so saving never rewrites what
// the editor does not understand.

export type ChecklistLine =
  | { kind: 'text'; text: string }
  | { kind: 'item'; prefix: string; done: boolean; text: string };

const ITEM = /^(\s*[-*+] )\[( |x|X)\] ?(.*)$/;

export const parseChecklist = (content: string): ChecklistLine[] => content.split('\n').map((text) => {
  const match = ITEM.exec(text);
  return match
    ? { kind: 'item', prefix: match[1] ?? '- ', done: match[2] !== ' ', text: match[3] ?? '' }
    : { kind: 'text', text };
});

export const serializeChecklist = (lines: readonly ChecklistLine[]): string => lines
  .map((line) => (line.kind === 'text' ? line.text : `${line.prefix}[${line.done ? 'x' : ' '}] ${line.text}`))
  .join('\n');

/**
 * A short fingerprint of the document for the host's save bookkeeping. Equal
 * text gives an equal version, so undoing back to the saved text is clean.
 */
export const checklistVersion = (content: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index += 1) {
    hash ^= content.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${content.length}:${(hash >>> 0).toString(16)}`;
};

/** Where a new item goes: after the last item, or at the end when there is none. */
export const insertItem = (lines: readonly ChecklistLine[], text: string): ChecklistLine[] => {
  let last = -1;
  let prefix = '- ';
  lines.forEach((line, index) => {
    if (line.kind !== 'item') return;
    last = index;
    prefix = line.prefix;
  });
  const item: ChecklistLine = { kind: 'item', prefix, done: false, text };
  if (last >= 0) return [...lines.slice(0, last + 1), item, ...lines.slice(last + 1)];
  // No items yet: append before the file's trailing newline.
  const endsWithNewline = lines.at(-1)?.kind === 'text' && lines.at(-1)?.text === '';
  const body = endsWithNewline ? lines.slice(0, -1) : [...lines];
  return [...body, item, { kind: 'text', text: '' }];
};
