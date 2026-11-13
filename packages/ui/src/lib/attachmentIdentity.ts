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
