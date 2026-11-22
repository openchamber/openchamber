type AttachmentIdentity = {
  filename: string;
  agentPath?: string;
};

export const attachmentWireName = (attachment: AttachmentIdentity): string =>
  attachment.agentPath ?? attachment.filename;

export const attachmentBasename = (value: string): string => {
  const normalized = /^(?:[A-Za-z]:\\|\\\\)/.test(value) ? value.replace(/\\/g, '/') : value;
  const segments = normalized.split('/');
  return segments[segments.length - 1] || value;
};

const citationKey = (filename: string): string => filename.trim().toLowerCase();

const citedAttachmentKeys = (text: string): Set<string> => (
  new Set(Array.from(text.matchAll(/\[([^\]\n]+)\]/g), (match) => citationKey(match[1])))
);

export const attachmentsCitedIn = <T extends { filename: string; sourceDocumentId?: string }>(text: string, files: readonly T[]): T[] => {
  if (files.length === 0) return [];
  const cited = citedAttachmentKeys(text);
  const citedDocuments = new Set(files.flatMap((file) => (
    file.sourceDocumentId && cited.has(citationKey(file.filename)) ? [file.sourceDocumentId] : []
  )));
  return files.filter((file) => cited.has(citationKey(file.filename))
    || (file.sourceDocumentId !== undefined && citedDocuments.has(file.sourceDocumentId)));
};

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

export const assignFileAttachmentFilenames = (files: readonly { name: string }[], existingFilenames: readonly string[]): string[] => {
  const used = new Set(existingFilenames.map(citationKey));
  return files.map((file) => {
    const filename = nextFreeName(file.name.replace(/\[/g, '(').replace(/\]/g, ')').trim() || 'file', used);
    used.add(citationKey(filename));
    return filename;
  });
};
