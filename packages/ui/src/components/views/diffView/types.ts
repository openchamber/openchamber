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
    submodule?: GitSubmoduleState | null;
};
export type DiffLoadFailure =
    | { kind: 'error'; message: string }
    | { kind: 'unavailable'; reason: GitPathUnavailableReason };
export type DiffScope = 'all' | PendingDiffScope;


export type ComparisonDiffResult =
    | { status: 'loading' }
    | { status: 'ready'; data: DiffData }
    | { status: 'large'; patch: string; changedLines: number; contextMode?: DiffContextMode; versions?: { original: string; modified: string } }
    | { status: 'error'; message: string };
export interface DiffFindReveal {
    key: string;
    nonce: number;
}
export interface DiffViewProps {
    visible?: boolean;
    hideStackedFileSidebar?: boolean;
    stackedDefaultCollapsedAll?: boolean;
    pinSelectedFileHeaderToTopOnNavigate?: boolean;
    showOpenInEditorAction?: boolean;
    diffScope?: DiffScope | null;
    onDiffScopeChange?: (scope: PendingDiffScope) => void;
    targetFilePath?: string | null;
    flushContent?: boolean;
    directory?: string | null;
}
