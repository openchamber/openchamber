import { type PendingDiffScope } from '@/stores/useUIStore';
import { type GitStatus, type GitSubmoduleState } from '@/lib/api/types';
import { type GitPathUnavailableReason } from '@/lib/api/git-path-diff';
import { type FileDiffMetadata } from '@pierre/diffs';

export type FileEntry = GitStatus['files'][number] & {
    insertions: number;
    deletions: number;
    isNew: boolean;
};

export type DiffContextMode = 'patch' | 'full';
export type DiffData = {
    original: string;
    modified: string;
    isBinary?: boolean;
    patch?: string;
    fileDiff?: FileDiffMetadata;
    contextMode?: DiffContextMode;
    /** Set for a live working or staged diff of a submodule; its patch alone can be empty. */
    submodule?: GitSubmoduleState | null;
};
/** An unavailable path is a stale or non-file status row, not a failed request. */
export type DiffLoadFailure =
    | { kind: 'error'; message: string }
    | { kind: 'unavailable'; reason: GitPathUnavailableReason };
export type DiffScope = 'all' | PendingDiffScope;


export type ComparisonDiffResult =
    | { status: 'loading' }
    | { status: 'ready'; data: DiffData }
    | { status: 'error'; message: string };
/** A find jump into a file: its entry renders it even past the large-diff gate. */
export interface DiffFindReveal {
    /** The match's source key: a file path, or a nested repository row plus the nested path. */
    key: string;
    nonce: number;
}
export interface DiffViewProps {
    visible?: boolean;
    hideStackedFileSidebar?: boolean;
    stackedDefaultCollapsedAll?: boolean;
    pinSelectedFileHeaderToTopOnNavigate?: boolean;
    showOpenInEditorAction?: boolean;
    /**
     * Null opens on the default: Branch on a branch that has one, else the
     * working tree. A scope the person picks is reported and passed back.
     */
    diffScope?: DiffScope | null;
    onDiffScopeChange?: (scope: PendingDiffScope) => void;
    targetFilePath?: string | null;
    /** Render diff content flush with the container edges (no outer padding). */
    flushContent?: boolean;
    /**
     * Another project's folder, for a pull request opened from the Tracker:
     * the view then shows that PR only, read through that project, with
     * nothing tied to the session on screen. Null works in the panel's own.
     */
    directory?: string | null;
}
