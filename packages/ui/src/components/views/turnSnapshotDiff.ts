/** One file of the last turn's diff, as `GET /api/session/:id/diff` answers it. */
export type TurnSnapshotDiff = {
    file?: string;
    status?: string;
    before?: string;
    after?: string;
    patch?: string;
    additions?: number;
    deletions?: number;
};

/** The git status letter a turn diff's status shows as in the file lists. */
export const statusToGitCode = (status?: string): string => {
    if (status === 'added') return 'A';
    if (status === 'deleted') return 'D';
    return 'M';
};
