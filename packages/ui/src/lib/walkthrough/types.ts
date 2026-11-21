import type { SourceControlReadContext } from '@/lib/source-control/types';


export type WalkthroughWorkingTreeScope = 'all' | 'staged' | 'working';

export type WalkthroughSource =
  | { kind: 'working-tree'; scope: WalkthroughWorkingTreeScope }
  | { kind: 'branch'; baseRef: string; headRef: string }
  | { kind: 'commit'; hash: string }
  | { kind: 'pr'; number: number; sourceRepo?: { owner: string; repo: string }; revision?: string; linked?: true };

type WalkthroughLocalSource = Exclude<WalkthroughSource, { kind: 'pr' }>;
type WalkthroughPullRequestSource = Extract<WalkthroughSource, { kind: 'pr' }>;

export type WalkthroughTarget =
  | { source: WalkthroughLocalSource }
  | { source: WalkthroughPullRequestSource; context: Readonly<SourceControlReadContext> };

export type WalkthroughChapterIcon = 'bug' | 'wrench' | 'path' | 'flask' | 'doc' | 'gear';
export type WalkthroughStopImportance = 'critical' | 'normal' | 'context';
export type WalkthroughObservationKind = 'decision' | 'cost' | 'limitation' | 'asymmetry' | 'unproven';

export interface WalkthroughObservation {
  kind: WalkthroughObservationKind;
  note: string;
}

export interface WalkthroughStop {
  id: string;
  title: string;
  hunkIds: string[];
  importance: WalkthroughStopImportance;
  prose: string;
  observations?: WalkthroughObservation[];
}

export interface WalkthroughChapter {
  id: string;
  title: string;
  icon: WalkthroughChapterIcon;
  blurb: string;
  stops: WalkthroughStop[];
}

export interface WalkthroughRoutineNote {
  path: string;
  note: string;
}

export interface Walkthrough {
  title: string;
  focus: string;
  chapters: WalkthroughChapter[];
  routine?: WalkthroughRoutineNote[];
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
  patch: string;
}

export interface WalkthroughModel {
  providerID: string;
  modelID: string;
  source?: string;
}

export interface WalkthroughResult {
  source: WalkthroughSource;
  readContext?: Readonly<SourceControlReadContext>;
  walkthrough: Walkthrough | null;
  model?: WalkthroughModel;
  language?: string | null;
  generatedAt?: string;
  fromCache?: boolean;
  hunks: WalkthroughHunk[];
  hunkCount: number;
  isStale?: boolean;
  missingHunkIds?: string[];
  staleStopIds?: string[];
  uncoveredHunkIds?: string[];
  readiness?: WalkthroughReadiness;
  generating?: boolean;
}

export type WalkthroughStage = 'collecting' | 'asking' | 'retrying' | 'assembling';

export type WalkthroughBlockedReason =
  | 'no-model'
  | 'no-provider-login'
  | 'empty-diff'
  | 'only-generated'
  | 'context-too-small'
  | 'structured-output-unsupported'
  | 'output-exhausted';

export type WalkthroughBlockedState = WalkthroughBlockedReason | 'server-unsupported';

export interface WalkthroughReadiness {
  ready: boolean;
  reason?: WalkthroughBlockedReason;
  model?: WalkthroughModel & {
    inputCharBudget?: number;
    contextTokens?: number;
    structuredOutput?: boolean | null;
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
