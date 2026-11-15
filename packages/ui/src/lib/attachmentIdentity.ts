type AttachmentIdentity = {
  filename: string;
  /** The on-disk path, when the runtime could resolve one for the attachment. */
  agentPath?: string;
};

export const attachmentWireName = (attachment: AttachmentIdentity): string =>
  attachment.agentPath ?? attachment.filename;

/** Preserve literal backslashes in POSIX filenames. */
export const attachmentBasename = (value: string): string => {
  const normalized = /^(?:[A-Za-z]:\\|\\\\)/.test(value) ? value.replace(/\\/g, '/') : value;
  const segments = normalized.split('/');
  return segments[segments.length - 1] || value;
};

const citationKey = (filename: string): string => filename.trim().toLowerCase();

/**
 * The names the text cites, normalized: a `[name]` chip, or the `[name](path)`
 * link an image saved as a file gets. The chip is an attachment's only handle
 * in the composer, so a send includes the attachments these name and leaves
 * the rest of the draft's files: deleting a chip drops its file, and undo,
 * which only rewrites the text, brings it back.
 */
const citedAttachmentKeys = (text: string): Set<string> => (
  new Set(Array.from(text.matchAll(/\[([^\]\n]+)\]/g), (match) => citationKey(match[1])))
);

/**
 * The attachments a send includes: those the text cites, and with a cited
 * document the images extracted from it, which share its `sourceDocumentId`
 * and have no chip of their own.
 */
export const attachmentsCitedIn = <T extends { filename: string; sourceDocumentId?: string }>(text: string, files: readonly T[]): T[] => {
  if (files.length === 0) return [];
  const cited = citedAttachmentKeys(text);
  const citedDocuments = new Set(files.flatMap((file) => (
    file.sourceDocumentId && cited.has(citationKey(file.filename)) ? [file.sourceDocumentId] : []
  )));
  return files.filter((file) => cited.has(citationKey(file.filename))
    || (file.sourceDocumentId !== undefined && citedDocuments.has(file.sourceDocumentId)));
};

/**
 * The text with a chip appended for every attachment it does not cite yet.
 * For drafts put back into the composer (a revert, a queued message taken out
 * to edit, a recalled prompt, a handed-over draft): messages sent before every
 * attachment had a chip carry files their text never named.
 */
export const withMissingCitations = (text: string, files: readonly { filename: string }[]): string => {
  if (files.length === 0) return text;
  const cited = citedAttachmentKeys(text);
  const missing = files.map((file) => file.filename).filter((filename) => !cited.has(citationKey(filename)));
  if (missing.length === 0) return text;
  const citations = missing.map((filename) => `[${filename}]`).join(' ');
  const head = text.replace(/\s+$/, '');
  return head ? `${head} ${citations}` : citations;
};

const nextFreeName = (name: string, used: Set<string>): string => {
  if (!used.has(citationKey(name))) return name;
  const lastDot = name.lastIndexOf('.');
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot) : '';
  let index = 2;
  while (used.has(citationKey(`${base}-${index}${ext}`))) index += 1;
  return `${base}-${index}${ext}`;
};

/**
 * Names for attached files: each keeps its own name unless another attachment
 * holds it, then gets `-2`, `-3` before the extension, so every chip names one
 * attachment and deleting it drops that one. Square brackets turn into
 * parentheses, since a `]` would end the chip's `[name]` early.
 */
export const assignFileAttachmentFilenames = (files: readonly { name: string }[], existingFilenames: readonly string[]): string[] => {
  const used = new Set(existingFilenames.map(citationKey));
  return files.map((file) => {
    const filename = nextFreeName(file.name.replace(/\[/g, '(').replace(/\]/g, ')').trim() || 'file', used);
    used.add(citationKey(filename));
    return filename;
  });
};
