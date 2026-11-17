import type { EditorAPI } from '@/lib/api/types';
import { findRepoFile, toAbsoluteFilePath } from '@/lib/path-utils';
import type { TurnSnapshotDiff } from '@/components/views/turnSnapshotDiff';

import { extractFirstChangedLineFromDiff } from './parts/toolDiffUtils';

export const openTurnFileDiffInEditor = async ({
    directory,
    editor,
    file,
    turnDiff,
}: {
    directory: string;
    editor: EditorAPI;
    file: string;
    turnDiff: readonly TurnSnapshotDiff[];
}): Promise<void> => {
    const absolutePath = toAbsoluteFilePath(directory, file);
    const listed = findRepoFile(absolutePath, directory, turnDiff.flatMap((entry) => entry.file ?? []));
    const patch = listed ? turnDiff.find((entry) => entry.file === listed)?.patch : undefined;
    if (!patch) {
        await editor.openFile(absolutePath);
        return;
    }
    await editor.openDiff('', absolutePath, undefined, { line: extractFirstChangedLineFromDiff(patch), patch });
};
