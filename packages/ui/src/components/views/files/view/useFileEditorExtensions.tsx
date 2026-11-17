import React from 'react';
import { toast } from '@/components/ui';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { codeHighlightExtension } from '@/lib/codemirror/codeHighlight';
import { ensurePierreThemeRegistered, getCodeTokenTheme } from '@/lib/shiki/appThemeRegistry';
import { useEditorCodeMetrics } from '@/lib/editorCodeMetrics';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { EditorView } from '@codemirror/view';
import { highlightSelectionMatches } from '@codemirror/search';
import { codeFolding } from '@/lib/codemirror/codeFolding';
import { bracketAids, multipleCursors } from '@/lib/codemirror/editingAids';
import { gitChangeGutter, setGitChangeBaseline } from '@/lib/codemirror/gitChangeGutter';
import { importLinks, resolveRelativeImport } from '@/lib/codemirror/importLinks';
import { indentGuides } from '@/lib/codemirror/indentGuides';
import { isLintedJsonPath, jsonSyntaxLint } from '@/lib/codemirror/jsonSyntaxLint';
import { stickyScope } from '@/lib/codemirror/stickyScope';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { useEffectiveGitDirectory, useGitStore } from '@/stores/useGitStore';
import { gitBaselineTarget } from '../gitBaselineTarget';
import type { useFilesViewState } from './useFilesViewState';
import type { useFileLanguage } from './useFileLanguage';
import type { useFileNavigation } from './useFileNavigation';

export function useFileEditorExtensions({
  t, files, git, currentTheme, isMobile, currentDirectory, root, panelRoot, wrapLines, lightTheme, darkTheme,
  selectedFile, editorViewRef, fileEditorKeymap, staticLanguageExtension, dynamicLanguageExtension,
  nudgeEditorSelectionAboveKeyboard,
}: Pick<ReturnType<typeof useFilesViewState>,
  't' | 'files' | 'git' | 'currentTheme' | 'isMobile' | 'currentDirectory' | 'root' | 'panelRoot' | 'wrapLines' |
  'lightTheme' | 'darkTheme' | 'selectedFile' | 'editorViewRef' | 'fileEditorKeymap'> &
Pick<ReturnType<typeof useFileLanguage>,
  'staticLanguageExtension' | 'dynamicLanguageExtension'> &
Pick<ReturnType<typeof useFileNavigation>,
  'nudgeEditorSelectionAboveKeyboard'>) {
  const editorFontSize = useUIStore((state) => state.editorFontSize);
  // The rendered preview follows the editor's font size, so zoom and the
  // Editor Font Size setting resize both modes. At the default 12 px it
  // renders at 14 px body and 12 px code.
  // SAFETY: CSS custom properties are valid inline styles; React's type lists only standard ones.
  const previewFontStyle = React.useMemo(() => ({
    '--text-markdown': `${editorFontSize + 2}px`,
    '--text-code': `${editorFontSize}px`,
  } as React.CSSProperties), [editorFontSize]);
  // The code preview is code at the editor's size and rows, so switching
  // between edit and view keeps the text in place.
  const editorCode = useEditorCodeMetrics();

  // Git change markers compare the open file with its HEAD version. The
  // server answers an empty original both for a new file and for one git does
  // not track at all (ignored, outside the repo's HEAD), so an empty baseline
  // counts only when git status lists the file as new.
  const selectedRelativePath = selectedFile?.path && root && selectedFile.path.startsWith(`${root}/`)
    ? selectedFile.path.slice(root.length + 1)
    : null;
  const selectedGitDirectory = useEffectiveGitDirectory(currentDirectory || null);
  const gitTarget = gitBaselineTarget(selectedFile?.path, currentDirectory, selectedGitDirectory);
  const gitDirectory = gitTarget?.directory ?? null;
  const gitRelativePath = gitTarget?.relativePath ?? null;
  // Refetch when the file's own status or the branch changes (a commit,
  // checkout or stash moves its HEAD version), not on every status refresh:
  // the selector returns a string, so unrelated refreshes do not re-render.
  const gitBaselineKey = useGitStore((state) => {
    if (!gitRelativePath || !gitDirectory) return null;
    // Keyed like the tree's own git status lookup.
    const status = state.directories.get(gitDirectory)?.status;
    const entry = status?.files.find((file) => file.path === gitRelativePath) ?? null;
    return JSON.stringify([gitDirectory, gitRelativePath, status?.current ?? null, entry]);
  });
  const [gitBaseline, setGitBaseline] = React.useState<{ path: string; directory: string; text: string | null } | null>(null);
  React.useEffect(() => {
    if (!selectedRelativePath || !gitRelativePath || !gitDirectory || !gitBaselineKey) {
      setGitBaseline(null);
      return;
    }
    let cancelled = false;
    if (!git.getGitFileDiff) {
      setGitBaseline(null);
      return;
    }
    git.getGitFileDiff(gitDirectory, { path: gitRelativePath })
      .then((diff) => {
        if (cancelled) return;
        const entry = useGitStore.getState().directories.get(gitDirectory)?.status?.files
          .find((file) => file.path === gitRelativePath);
        const isNewInGit = entry !== undefined
          && (entry.index === '?' || entry.index === 'A' || entry.working_dir === '?');
        const usable = !diff.isBinary && !diff.submodule && (diff.original !== '' || isNewInGit);
        setGitBaseline({ path: selectedRelativePath, directory: gitDirectory, text: usable ? diff.original : null });
      })
      .catch(() => {
        if (!cancelled) setGitBaseline({ path: selectedRelativePath, directory: gitDirectory, text: null });
      });
    return () => {
      cancelled = true;
    };
    // gitBaselineKey carries the status fields that decide a refetch.
  }, [git, gitBaselineKey, gitDirectory, gitRelativePath, selectedRelativePath]);
  const gitBaselineRef = React.useRef(gitBaseline);
  gitBaselineRef.current = gitBaseline;
  const applyGitBaseline = React.useCallback((view: EditorView | null) => {
    if (!view) return;
    const baseline = gitBaselineRef.current;
    setGitChangeBaseline(view, baseline && baseline.path === selectedRelativePath && baseline.directory === gitDirectory ? baseline.text : null);
  }, [gitDirectory, selectedRelativePath]);
  React.useEffect(() => {
    applyGitBaseline(editorViewRef.current);
  }, [applyGitBaseline, gitBaseline]);

  // Typing into a file opened as a preview keeps its tab, as in VS Code. Only
  // user edits count: loading or syncing a file also changes the document.
  const pinPreviewOnEditRef = React.useRef<() => void>(() => {});
  pinPreviewOnEditRef.current = () => {
    if (!selectedFile?.path || !panelRoot) return;
    const directoryKey = normalizeContextPanelDirectoryKey(panelRoot);
    const state = useUIStore.getState();
    const previewTab = state.contextPanelByDirectory[directoryKey]?.tabs
      .find((tab) => tab.preview && tab.targetPath === selectedFile.path);
    if (previewTab) state.pinContextPanelTab(directoryKey, previewTab.id);
  };
  const pinPreviewOnEditExtension = React.useMemo(() => EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const edited = update.transactions.some((transaction) => (
      transaction.isUserEvent('input') || transaction.isUserEvent('delete')
      || transaction.isUserEvent('undo') || transaction.isUserEvent('redo') || transaction.isUserEvent('move')
    ));
    if (edited) pinPreviewOnEditRef.current();
  }), []);

  // Cmd/Ctrl+click on a relative import opens the file it names. The handler
  // reads the latest render through a ref, so the extension keeps its identity.
  const openRelativeImportRef = React.useRef<(specifier: string) => void>(() => {});
  openRelativeImportRef.current = (specifier) => {
    const fromFile = selectedFile?.path;
    if (!fromFile || !panelRoot) return;
    void resolveRelativeImport(fromFile, specifier, async (directory) => {
      try {
        const listing = await files.listDirectory(directory);
        return new Map(listing.entries.map((entry) => [entry.name, entry.isDirectory]));
      } catch {
        return null;
      }
    }).then((resolution) => {
      if (resolution.status === 'found') {
        useUIStore.getState().openContextFile(panelRoot, resolution.path);
        return;
      }
      toast.error(resolution.status === 'missing'
        ? t('filesView.editor.importNotFound', { path: specifier })
        : t('filesView.editor.importLookupFailed', { path: specifier }));
    });
  };
  const importLinksExtension = React.useMemo(() => importLinks((specifier) => openRelativeImportRef.current(specifier)), []);

  const editorExtensions = React.useMemo(() => {
    if (!selectedFile?.path) {
      return [createFlexokiCodeMirrorTheme(currentTheme, { fontSize: editorFontSize })];
    }

    // Token colors from the file view's highlighter (see codeHighlight.ts).
    // Same language resolver as the view, so both agree on the language. When
    // it is the color source, drop the lezer token colors to avoid a
    // competing highlighter (Keep the lezer language for indentation/folding).
    const highlightLanguage = getLanguageFromExtension(selectedFile.path);
    const extensions = [createFlexokiCodeMirrorTheme(currentTheme, highlightLanguage ? { syntaxColors: false, fontSize: editorFontSize } : { fontSize: editorFontSize })];
    const language = staticLanguageExtension ?? dynamicLanguageExtension;
    if (language) {
      extensions.push(language);
    }
    if (highlightLanguage) {
      extensions.push(codeHighlightExtension({
        language: highlightLanguage,
        theme: getCodeTokenTheme(currentTheme).zed,
      }));
    }
    if (wrapLines) {
      extensions.push(EditorView.lineWrapping);
    }
    const diffColors = currentTheme.colors.syntax.highlights;
    extensions.push(
      gitChangeGutter({
        added: diffColors?.diffAdded ?? currentTheme.colors.status.success,
        modified: diffColors?.diffModified ?? currentTheme.colors.status.info,
        removed: diffColors?.diffRemoved ?? currentTheme.colors.status.error,
      }, {
        revert: t('filesView.editor.gitHunk.revert'),
        close: t('filesView.editor.gitHunk.close'),
      }),
      highlightSelectionMatches({ highlightWordAroundCursor: true, minSelectionLength: 2 }),
      pinPreviewOnEditExtension,
      bracketAids(),
      indentGuides(),
      importLinksExtension,
    );
    if (isLintedJsonPath(selectedFile.path)) {
      extensions.push(jsonSyntaxLint(t('filesView.editor.jsonSyntaxError'), {
        error: currentTheme.colors.status.error,
        tooltipBackground: currentTheme.colors.surface.elevated,
        tooltipForeground: currentTheme.colors.surface.elevatedForeground,
        border: currentTheme.colors.interactive.border,
      }));
    }
    if (!isMobile) {
      extensions.push(codeFolding(), multipleCursors({ vimMode: fileEditorKeymap === 'vim' }), stickyScope());
    }
    if (isMobile) {
      extensions.push(EditorView.updateListener.of((update) => {
        if (!update.view.hasFocus) {
          return;
        }
        if (!(update.selectionSet || update.focusChanged || update.viewportChanged || update.geometryChanged)) {
          return;
        }

        window.requestAnimationFrame(() => {
          nudgeEditorSelectionAboveKeyboard(update.view);
        });
      }));
    }
    return extensions;
  }, [currentTheme, selectedFile?.path, staticLanguageExtension, dynamicLanguageExtension, wrapLines, isMobile, nudgeEditorSelectionAboveKeyboard, editorFontSize, pinPreviewOnEditExtension, fileEditorKeymap, t, importLinksExtension]);

  const pierreTheme = React.useMemo(
    () => ({ light: ensurePierreThemeRegistered(lightTheme), dark: ensurePierreThemeRegistered(darkTheme) }),
    [lightTheme, darkTheme],
  );
  return {
  previewFontStyle, editorCode, applyGitBaseline, editorExtensions, pierreTheme,
  };
}
