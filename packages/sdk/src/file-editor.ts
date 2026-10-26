// File editors (`contributes.fileEditors`): the host's Files view opens files
// whose names match an editor's patterns in that editor's frame. The host owns
// the file: it reads it, hands the text to the frame, asks for the edited text
// when it saves, and keeps saving, autosave, the unsaved-changes prompt, and
// external-change handling. The editor never touches the disk.

/** Editors one package may declare. */
export const GUEST_FILE_EDITORS_MAX = 8;
/** Characters in an editor's `title`. */
export const GUEST_FILE_EDITOR_TITLE_MAX = 60;
/** File-name patterns one editor may list. */
export const GUEST_FILE_EDITOR_PATTERNS_MAX = 16;
/** Characters in one file-name pattern. */
export const GUEST_FILE_EDITOR_PATTERN_MAX = 128;
/**
 * Characters of file text, or bytes of a binary file, the host hands to an
 * editor and accepts back. Larger than `GUEST_FILE_CONTENT_MAX`: drawings with
 * embedded images and office documents run to several megabytes. A larger
 * file stays with the host's own view.
 */
export const GUEST_FILE_EDITOR_CONTENT_MAX = 20_000_000;
/** Characters in the version a snapshot carries. */
export const GUEST_FILE_EDITOR_VERSION_MAX = 256;

export type FileEditorContribution = {
  /** Kebab-case, unique within the package. */
  id: string;
  /** Shown where the host names the editor. */
  title: string;
  /** File-name globs, matched case-insensitively against the name only: `*` is any run, `?` one character. */
  match: string[];
  /** Package-local `.html` the Files view loads for a matching file. */
  entry: string;
  /**
   * `text` (the default) hands over the file as a string and only claims text
   * files. `binary` hands over its bytes and claims any matching file, binary
   * or not; the host has no source view for it.
   */
  content?: FileEditorContentKind;
};

export type FileEditorContentKind = 'text' | 'binary';

/**
 * A file-name glob: no path separators or NUL, and at least one character
 * that is not a wildcard, so no editor can claim every file.
 */
export const isFileEditorPattern = (value: string): boolean => (
  value.length > 0
  && value.length <= GUEST_FILE_EDITOR_PATTERN_MAX
  && !/[/\\\0]/.test(value)
  && /[^*?]/.test(value)
);

const patternExpressions = new Map<string, RegExp>();

const patternExpression = (pattern: string): RegExp => {
  const cached = patternExpressions.get(pattern);
  if (cached) return cached;
  const source = pattern
    .split('')
    .map((character) => {
      if (character === '*') return '.*';
      if (character === '?') return '.';
      return character.replace(/[\\^$.|+()[\]{}]/g, '\\$&');
    })
    .join('');
  const expression = new RegExp(`^${source}$`, 'is');
  patternExpressions.set(pattern, expression);
  return expression;
};

/** Whether `fileName` (a name, not a path) matches one file-editor pattern. */
export const matchesFileEditorPattern = (fileName: string, pattern: string): boolean => (
  isFileEditorPattern(pattern) && patternExpression(pattern).test(fileName)
);

/** What the host hands the editor: the file it opened. */
export type FileEditorDocument = {
  /** Path as the host shows it; for display, never for reading. */
  path: string;
  name: string;
  /** True when the host will not save this file; the editor should not offer edits. */
  readOnly: boolean;
} & (
  /** The file's text with `\n` line endings; the host restores the file's own on write. */
  | { encoding: 'text'; content: string }
  /** The file's bytes, exactly as on disk. */
  | { encoding: 'binary'; bytes: Uint8Array<ArrayBuffer> }
);

/**
 * The edited file and the version of the editor's state it came from: text
 * for a `text` editor, bytes for a `binary` one.
 */
export type FileEditorSnapshot = {
  /** Opaque to the host; handed back through `onFileSaved` once this snapshot is on disk. */
  version: string;
} & ({ content: string } | { bytes: Uint8Array<ArrayBuffer> });

/** Characters of text or bytes a snapshot or document carries. */
export const fileEditorPayloadSize = (value: { content: string } | { bytes: Uint8Array<ArrayBuffer> }): number => (
  'bytes' in value ? value.bytes.byteLength : value.content.length
);

/** Whether two documents are the same file with the same content, byte for byte. */
export const sameFileEditorDocument = (left: FileEditorDocument, right: FileEditorDocument): boolean => {
  if (left.path !== right.path || left.readOnly !== right.readOnly) return false;
  if (left.encoding === 'text' || right.encoding === 'text') {
    return left.encoding === 'text' && right.encoding === 'text' && left.content === right.content;
  }
  if (left.bytes.byteLength !== right.bytes.byteLength) return false;
  for (let index = 0; index < left.bytes.byteLength; index += 1) {
    if (left.bytes[index] !== right.bytes[index]) return false;
  }
  return true;
};

/**
 * Why the host wants a snapshot: `save` writes it to disk, `handoff` moves it
 * into the host's source view or to the other place the editor is shown.
 */
export type FileSnapshotPurpose = 'save' | 'handoff';

export type FileSnapshotRequest = { purpose: FileSnapshotPurpose };

export type FileSnapshotResultPayload =
  | { snapshot: FileEditorSnapshot }
  | { error: string };

/** The editor's state after a change: `dirty` against what was saved, `edited` when the document itself changed. */
export type FileEditorChange = {
  dirty: boolean;
  edited: boolean;
};

/**
 * Tracks whether an editor differs from what was last written. The host
 * writes one snapshot and reports that snapshot's version saved, so edits
 * made while the write ran leave the editor dirty instead of being recorded as
 * saved but never written.
 */
export const createFileSaveTracker = (initialVersion: string | null) => {
  let saved = initialVersion;
  let live = initialVersion;
  return {
    /** A new live version; `edited` is true when it differs from the previous one. */
    observe: (version: string): FileEditorChange => {
      const edited = version !== live;
      live = version;
      return { edited, dirty: version !== saved };
    },
    /** Records a written version; returns whether the live state is still dirty. */
    markSaved: (version: string): boolean => {
      saved = version;
      return live !== version;
    },
  };
};
