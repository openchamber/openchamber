import { describe, expect, test } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

describe('Files view ownership', () => {
  test('composition names its dependencies without a surface-wide state bag', () => {
    expect(existsSync(fileURLToPath(new URL('useFilesViewState.tsx', import.meta.url)))).toBe(false);
    expect(/\.\.\./.test(source('../../FilesView.tsx'))).toBe(false);
  });

  test('classification has no reads, pending navigation or editor effects', () => {
    expect(/listDirectory|useEffect|pendingFileNavigation|visible/.test(source('useFileKinds.tsx'))).toBe(false);
  });

  test('file operations own opening, submitting and closing their dialogs', () => {
    const operations = source('useFileOperations.tsx');
    for (const handler of ['handleOpenDialog', 'handleDialogSubmit', 'handleCloseDialog']) {
      expect(operations).toContain(`const ${handler}`);
    }
    expect(/handleDialogSubmit|moveWorkspacePath|activeDialog/.test(source('useFileDirectory.tsx'))).toBe(false);
    expect(/handleCloseDialog|setActiveDialog/.test(source('useFilePreviewRendering.tsx'))).toBe(false);
  });

  test('canvas rendering has no comment UI', () => {
    expect(/wholeFileComment|ScrollableOverlay/.test(source('useFileCanvas.tsx'))).toBe(false);
    expect(source('useFileComments.tsx')).toContain('const wholeFileCommentPanel');
  });

  test('pending navigation has no shortcuts or mobile keyboard clearance', () => {
    expect(/useKeybind|visualViewport|nudgeEditorSelectionAboveKeyboard/.test(source('useFileNavigation.tsx'))).toBe(false);
    expect(source('useFileKeybinds.tsx')).toContain("useKeybind('open_go_to_line'");
    expect(source('useFileMobileKeyboard.tsx')).toContain('visualViewport');
  });
});
