import type { EditorAPI } from '@/lib/api/types';
import { toAbsoluteFilePath } from '@/lib/path-utils';

import { extractFirstChangedLineFromDiff, getApplyPatchFilePath, getPatchText } from './toolDiffUtils';

export const openApplyPatchFileInEditor = ({
    currentDirectory,
    diffLabel,
    editor,
    file,
    isVSCode,
}: {
    currentDirectory: string;
    diffLabel: string;
    editor: EditorAPI;
    file: Record<string, unknown>;
    isVSCode: boolean;
}): boolean => {
    const filePath = getApplyPatchFilePath(file);
    if (!filePath || file.type === 'delete') {
        return false;
    }

    const patch = getPatchText(file.patch) ?? getPatchText(file.diff);
    const line = patch ? extractFirstChangedLineFromDiff(patch) : undefined;
    const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
    if (isVSCode && patch) {
        void editor.openDiff('', absolutePath, diffLabel, { line, patch });
    } else {
        void editor.openFile(absolutePath, line);
    }
    return true;
};
