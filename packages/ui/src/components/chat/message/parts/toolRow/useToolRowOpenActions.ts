import React from 'react';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { Metadata, ToolInput, ToolPart as ToolPartType } from '@/lib/opencode/model';
import { useUIStore } from '@/stores/useUIStore';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { hasTextSelectionInside } from '@/lib/textSelection';
import { isEditTool, isPatchTool, isWriteTool, toolInputPath } from '@/lib/opencode/tools';
import { getApplyPatchFilePath, getFirstChangedLineFromMetadata, getPrimaryDiffFromMetadata, getPrimaryToolPath, resolveToolQuickOpenTarget } from '../toolDiffUtils';
import { openApplyPatchFileInEditor } from '../applyPatchEditorAction';
import { getRelativePath } from './toolPaths';

export const useToolRowOpenActions = ({
    part,
    normalizedPartTool,
    input,
    metadata,
    currentDirectory,
    isTaskTool,
    onToggle,
}: {
    part: ToolPartType;
    normalizedPartTool: string;
    input: ToolInput | undefined;
    metadata: Metadata | undefined;
    currentDirectory: string;
    isTaskTool: boolean;
    onToggle: (toolId: string) => void;
}) => {
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();

    const openApplyPatchFile = (file: Record<string, unknown>, event: React.MouseEvent<HTMLButtonElement>) => {
        if (!runtime?.editor) {
            return;
        }

        event.stopPropagation();
        if (hasTextSelectionInside(event.currentTarget)) {
            return;
        }
        const rawPath = getApplyPatchFilePath(file);
        const displayPath = rawPath ? getRelativePath(rawPath, currentDirectory) : '';
        openApplyPatchFileInEditor({
            currentDirectory,
            diffLabel: `${displayPath} (changes)`,
            editor: runtime.editor,
            file,
            isVSCode: runtime.runtime.isVSCode,
        });
    };

    const handleMainClick = (e: { stopPropagation: () => void }) => {
        if (isTaskTool || !runtime?.editor) {
            onToggle(part.id);
            return;
        }

        let filePath: unknown;
        let targetLine: number | undefined;
        let toolDiff: string | undefined;
        if (isEditTool(normalizedPartTool)) {
            filePath = input?.filePath || input?.file_path || input?.path || metadata?.filePath || metadata?.file_path || metadata?.path;
            if (typeof filePath === 'string') {
                toolDiff = getPrimaryDiffFromMetadata(normalizedPartTool, metadata, filePath);
                targetLine = getFirstChangedLineFromMetadata(normalizedPartTool, metadata, filePath);
            }
        } else if (isPatchTool(normalizedPartTool)) {
            filePath = getPrimaryToolPath(normalizedPartTool, input, metadata);
            if (typeof filePath === 'string') {
                toolDiff = getPrimaryDiffFromMetadata(normalizedPartTool, metadata, filePath);
                targetLine = getFirstChangedLineFromMetadata(normalizedPartTool, metadata, filePath);
            }
        } else if (isWriteTool(normalizedPartTool)) {
            filePath = toolInputPath(input);
        }

        if (typeof filePath === 'string') {
            e.stopPropagation();
            const absolutePath = toAbsoluteFilePath(currentDirectory, filePath);
            if (runtime.runtime.isVSCode && toolDiff && (isEditTool(normalizedPartTool) || isPatchTool(normalizedPartTool))) {
                const label = `${getRelativePath(absolutePath, currentDirectory)} (changes)`;
                void runtime.editor.openDiff('', absolutePath, label, { line: targetLine, patch: toolDiff });
                return;
            }
            runtime.editor.openFile(absolutePath, targetLine);
        } else {
            onToggle(part.id);
        }
    };

    const handleMainRowClick = (event: React.MouseEvent<HTMLDivElement>) => {
        // Selecting the tool title must not open the file or toggle the row.
        if (hasTextSelectionInside(event.currentTarget)) return;
        handleMainClick(event);
    };

    const handleMainKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        // Nested buttons (quick-open, copy) handle their own Enter/Space; the row
        // must not swallow the key and toggle instead.
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') {
            return;
        }
        event.preventDefault();
        handleMainClick(event);
    };

    // Quick-open target for the file-link icon in the tool header. Resolves the
    // primary file path (and, for diff tools, the first changed line + diff) so
    // the user can open the file in the side panel (web/desktop) or editor
    // (VS Code) without expanding the tool card. Reuses the same path helpers as
    // handleMainClick above; the difference is the web fallback — handleMainClick
    // only opens when runtime.editor is available, this icon also falls back to
    // useUIStore.openContextFile{AtLine} so the file opens in the right pane.
    const quickOpenTarget = React.useMemo<{ absolutePath: string; line?: number; toolDiff?: string; toolName: string } | null>(() => {
        if (isTaskTool) return null;
        const toolName = normalizedPartTool || part.tool;
        const target = resolveToolQuickOpenTarget(toolName, input, metadata);
        if (!target) return null;
        return {
            absolutePath: toAbsoluteFilePath(currentDirectory, target.filePath),
            line: target.line,
            toolDiff: target.patch,
            toolName,
        };
    }, [isTaskTool, normalizedPartTool, part.tool, input, metadata, currentDirectory]);

    const openQuickTarget = () => {
        if (!quickOpenTarget) return;
        const { absolutePath, line, toolDiff, toolName } = quickOpenTarget;
        if (runtime?.editor) {
            if (runtime.runtime.isVSCode && toolDiff && (isEditTool(toolName) || isPatchTool(toolName))) {
                const label = `${getRelativePath(absolutePath, currentDirectory)} (changes)`;
                void runtime.editor.openDiff('', absolutePath, label, { line, patch: toolDiff });
                return;
            }
            runtime.editor.openFile(absolutePath, line);
            return;
        }
        const uiStore = useUIStore.getState();
        if (typeof line === 'number' && Number.isFinite(line)) {
            uiStore.openContextFileAtLine(currentDirectory, absolutePath, Math.max(1, Math.trunc(line)), 1);
        } else {
            uiStore.openContextFile(currentDirectory, absolutePath);
        }
        mobileActions?.openFiles();
    };

    const handleQuickOpen = (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        openQuickTarget();
    };

    return { openApplyPatchFile, handleMainRowClick, handleMainKeyDown, quickOpenTarget, handleQuickOpen };
};
