/**
 * Contract for the AI diff walkthrough, mirrored from
 * `packages/web/server/lib/walkthrough`.
 *
 * Hunk ids are opaque here on purpose: the server owns how they are derived,
 * and the client only ever matches them against the index it is handed.
 */

export type WalkthroughWorkingTreeScope = 'all' | 'staged' | 'working';

export type WalkthroughSource =
  | { kind: 'working-tree'; scope: WalkthroughWorkingTreeScope }
  | { kind: 'branch'; baseRef: string; headRef: string }
  | { kind: 'pr'; number: number };

export type WalkthroughChapterIcon = 'bug' | 'wrench' | 'path' | 'flask' | 'doc' | 'gear';
export type WalkthroughStopImportance = 'critical' | 'normal' | 'context';

export interface WalkthroughStop {
  id: string;
  title: string;
  hunkIds: string[];
  importance: WalkthroughStopImportance;
  prose: string;
}

export interface WalkthroughChapter {
  id: string;
  title: string;
  icon: WalkthroughChapterIcon;
  blurb: string;
  stops: WalkthroughStop[];
}

export interface Walkthrough {
  title: string;
  focus: string;
  chapters: WalkthroughChapter[];
}

export interface WalkthroughHunk {
  id: string;
  path: string;
  oldPath: string | null;
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  scope: string;
  header: string;
  newStart: number;
  added: number;
  deleted: number;
  /** Standalone patch for this hunk, including the file header. */
  patch: string;
}

export interface WalkthroughModel {
  providerID: string;
  modelID: string;
  source?: string;
}

export interface WalkthroughResult {
  source: WalkthroughSource;
  walkthrough: Walkthrough | null;
  model?: WalkthroughModel;
  /**
   * Language the prose on screen is written in — not necessarily the one being
   * asked for now. Null for an entry written before the setting existed.
   */
  language?: string | null;
  generatedAt?: string;
  fromCache?: boolean;
  hunks: WalkthroughHunk[];
  hunkCount: number;
  /** True when at least one stop points at code that has since changed. */
  isStale?: boolean;
  missingHunkIds?: string[];
  staleStopIds?: string[];
  /** Hunks in the current diff that no stop covers. Rendered as a tail. */
  uncoveredHunkIds?: string[];
  /** Whether generating is possible at all, computed from the same diff. */
  readiness?: WalkthroughReadiness;
  /** A generation is already running on the server for this source. */
  generating?: boolean;
}

/**
 * Only phases a person can wait on. Building the digest and reading the cache
 * take milliseconds; naming them would imply progress that is not happening.
 */
export type WalkthroughStage = 'collecting' | 'asking' | 'retrying' | 'assembling';

/** Reasons the server reports for refusing to generate. */
export type WalkthroughBlockedReason =
  | 'no-model'
  | 'no-provider-login'
  | 'empty-diff'
  | 'only-generated'
  | 'context-too-small'
  | 'structured-output-unsupported'
  | 'output-exhausted';

/**
 * Everything the panel can render as a blocking screen. `server-unsupported` is
 * never sent by a server — it is what the client concludes when the answer is
 * not JSON at all, which is how a server too old to have these routes replies.
 */
export type WalkthroughBlockedState = WalkthroughBlockedReason | 'server-unsupported';

export interface WalkthroughReadiness {
  ready: boolean;
  reason?: WalkthroughBlockedReason;
  model?: WalkthroughModel & {
    inputCharBudget?: number;
    contextTokens?: number;
    structuredOutput?: boolean | null;
    /** False when the resolved provider has no usable OpenCode login. */
    hasLogin?: boolean;
  };
  requiredChars?: number;
  availableChars?: number;
  hunkCount?: number;
  fileCount?: number;
  generatedFileCount?: number;
}

export class WalkthroughError extends Error {
  readonly code?: WalkthroughBlockedState | 'invalid-walkthrough' | 'github-not-connected' | 'no-github-remote';
  readonly model?: WalkthroughModel;
  readonly requiredChars?: number;
  readonly availableChars?: number;

  constructor(
    message: string,
    details: {
      code?: WalkthroughError['code'];
      model?: WalkthroughModel;
      requiredChars?: number;
      availableChars?: number;
    } = {}
  ) {
    super(message);
    this.name = 'WalkthroughError';
    this.code = details.code;
    this.model = details.model;
    this.requiredChars = details.requiredChars;
    this.availableChars = details.availableChars;
  }
}
