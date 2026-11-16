
export const GUEST_FILE_EDITORS_MAX = 8;
export const GUEST_FILE_EDITOR_TITLE_MAX = 60;
export const GUEST_FILE_EDITOR_PATTERNS_MAX = 16;
export const GUEST_FILE_EDITOR_PATTERN_MAX = 128;
export const GUEST_FILE_EDITOR_CONTENT_MAX = 20_000_000;
export const GUEST_FILE_EDITOR_VERSION_MAX = 256;

export type FileEditorContribution = {
  id: string;
  title: string;
  match: string[];
  entry: string;
  content?: FileEditorContentKind;
};

export type FileEditorContentKind = 'text' | 'binary';

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

export const matchesFileEditorPattern = (fileName: string, pattern: string): boolean => (
  isFileEditorPattern(pattern) && patternExpression(pattern).test(fileName)
);

export type FileEditorDocument = {
  path: string;
  name: string;
  readOnly: boolean;
} & (
  | { encoding: 'text'; content: string }
  | { encoding: 'binary'; bytes: Uint8Array<ArrayBuffer> }
);

export type FileEditorSnapshot = {
  version: string;
} & ({ content: string } | { bytes: Uint8Array<ArrayBuffer> });

export const fileEditorPayloadSize = (value: { content: string } | { bytes: Uint8Array<ArrayBuffer> }): number => (
  'bytes' in value ? value.bytes.byteLength : value.content.length
);

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

export type FileSnapshotPurpose = 'save' | 'handoff';

export type FileSnapshotRequest = { purpose: FileSnapshotPurpose };

export type FileSnapshotResultPayload =
  | { snapshot: FileEditorSnapshot }
  | { error: string };

export type FileEditorChange = {
  dirty: boolean;
  edited: boolean;
};

export const createFileSaveTracker = (initialVersion: string | null) => {
  let saved = initialVersion;
  let live = initialVersion;
  return {
    observe: (version: string): FileEditorChange => {
      const edited = version !== live;
      live = version;
      return { edited, dirty: version !== saved };
    },
    markSaved: (version: string): boolean => {
      saved = version;
      return live !== version;
    },
  };
};
