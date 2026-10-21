/**
 * How an attachment is named to the model, and how the transcript still finds
 * its citation.
 *
 * OpenCode presents a prompt file's `name` to the model as the file's
 * identity, and the model turns that into its `Read` call. A basename it
 * cannot resolve — `report.xlsx` for a file dropped from the OS outside the
 * session's directory — sends it searching the disk, or reading the wrong
 * file when two share a name. When the intake path resolved the file's real
 * location (`pathForDroppedFile`, the desktop shell's `webUtils.getPathForFile`),
 * that path is what the model needs.
 *
 * The composer's own surfaces keep the basename: `attachmentWireName` is only
 * the identity handed to the model, so chip labels, `@`-mention matching and
 * the `[basename]` citation stay exactly as they are. Because the identity the
 * model sees may now be a path, the transcript matches a citation by the
 * attachment's basename (`attachmentBasename`), which is what the composer
 * inserts and what the reader sees.
 */

type AttachmentIdentity = {
  filename: string;
  /** The on-disk path, when the runtime could resolve one for the attachment. */
  agentPath?: string;
};

export const attachmentWireName = (attachment: AttachmentIdentity): string =>
  attachment.agentPath ?? attachment.filename;

/** The last path segment, on either separator. */
export const attachmentBasename = (value: string): string => {
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return segments[segments.length - 1] || value;
};
