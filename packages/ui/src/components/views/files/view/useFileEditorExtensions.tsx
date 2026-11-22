import React from 'react';
import { toast } from '@/components/ui';
import { syncVimMappings } from '@/lib/codemirror/vimModeExtension';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { EditorView } from '@codemirror/view';
import { useUIStore, normalizeContextPanelDirectoryKey } from '@/stores/useUIStore';
import { useGitStore, useEffectiveGitDirectory } from '@/stores/useGitStore';
import { useI18n } from '@/lib/i18n';
import { createFlexokiCodeMirrorTheme } from '@/lib/codemirror/flexokiTheme';
import { codeHighlightExtension } from '@/lib/codemirror/codeHighlight';
import { ensurePierreThemeRegistered, getCodeTokenTheme } from '@/lib/shiki/appThemeRegistry';
import { useEditorCodeMetrics } from '@/lib/editorCodeMetrics';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import { highlightSelectionMatches, getSearchQuery, SearchQuery, setSearchQuery as setEditorSearchQuery } from '@codemirror/search';
import { codeFolding } from '@/lib/codemirror/codeFolding';
import { bracketAids, multipleCursors } from '@/lib/codemirror/editingAids';
import { gitChangeGutter, setGitChangeBaseline } from '@/lib/codemirror/gitChangeGutter';
import { importLinks, resolveRelativeImport } from '@/lib/codemirror/importLinks';
import { indentGuides } from '@/lib/codemirror/indentGuides';
import { isLintedJsonPath, jsonSyntaxLint } from '@/lib/codemirror/jsonSyntaxLint';
import { stickyScope } from '@/lib/codemirror/stickyScope';
import { gitBaselineTarget } from '../gitBaselineTarget';
import { type useFileComments } from './useFileComments';
import { type useFileLanguage } from './useFileLanguage';
import { type useFileMobileKeyboard } from './useFileMobileKeyboard';
import { type useFileScope } from './useFileScope';
import { type useFileTabs } from './useFileTabs';
import { type useFileThemes } from './useFileThemes';
import { type useFileKinds } from './useFileKinds';

export function useFileEditor() {
  const wrapLines = useUIStore((state) => state.fileEditorWrapLines);
  const setWrapLines = useUIStore((state) => state.setFileEditorWrapLines);
  const [isSearchOpen, setIsSearchOpen] = React.useState(false);
  const toolbarDropdownOpenCountRef = React.useRef(0);

  const handleToolbarDropdownOpenChange = React.useCallback((open: boolean) => {
    toolbarDropdownOpenCountRef.current = Math.max(
      0,
      toolbarDropdownOpenCountRef.current + (open ? 1 : -1),
    );
  }, []);
  const editorViewRef = React.useRef<EditorView | null>(null);
  const editorWrapperRef = React.useRef<HTMLDivElement | null>(null);
  const [editorViewReadyNonce, setEditorViewReadyNonce] = React.useState(0);
  const [isGoToLineOpen, setIsGoToLineOpen] = React.useState(false);
  const [isSymbolsOpen, setIsSymbolsOpen] = React.useState(false);
  const fileEditorKeymap = useUIStore((state) => state.fileEditorKeymap);
  const fileEditorVimMappings = useUIStore((state) => state.fileEditorVimMappings);
  React.useEffect(() => {
    if (fileEditorKeymap === 'vim') syncVimMappings(fileEditorVimMappings);
  }, [fileEditorKeymap, fileEditorVimMappings]);

  return { wrapLines, setWrapLines, isSearchOpen, setIsSearchOpen, handleToolbarDropdownOpenChange, editorViewRef, editorWrapperRef, editorViewReadyNonce, setEditorViewReadyNonce, isGoToLineOpen, setIsGoToLineOpen, isSymbolsOpen, setIsSymbolsOpen, fileEditorKeymap };
}

export function useFileEditorExtensions({ editor, fileComments, fileLanguage, mobileKeyboard, scope, tabs, themes, files, git, isMobile, t }: {
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewRef' | 'fileEditorKeymap' | 'wrapLines'>;
  fileComments: Pick<ReturnType<typeof useFileComments>, 'codeSelectionComment'>;
  fileLanguage: Pick<ReturnType<typeof useFileLanguage>, 'dynamicLanguageExtension' | 'staticLanguageExtension'>;
  mobileKeyboard: Pick<ReturnType<typeof useFileMobileKeyboard>, 'nudgeEditorSelectionAboveKeyboard'>;
  scope: Pick<ReturnType<typeof useFileScope>, 'currentDirectory' | 'panelRoot' | 'root'>;
  tabs: Pick<ReturnType<typeof useFileTabs>, 'selectedFile'>;
  themes: Pick<ReturnType<typeof useFileThemes>, 'currentTheme' | 'darkTheme' | 'lightTheme'>;
  files: ReturnType<typeof useRuntimeAPIs>['files'];
  git: ReturnType<typeof useRuntimeAPIs>['git'];
  isMobile: boolean;
  t: ReturnType<typeof useI18n>['t'];
}) {
  const { editorViewRef, fileEditorKeymap, wrapLines } = editor;
  const { codeSelectionComment } = fileComments;
  const { dynamicLanguageExtension, staticLanguageExtension } = fileLanguage;
  const { nudgeEditorSelectionAboveKeyboard } = mobileKeyboard;
  const { currentDirectory, panelRoot, root } = scope;
  const { selectedFile } = tabs;
  const { currentTheme, darkTheme, lightTheme } = themes;

  const editorFontSize = useUIStore((state) => state.editorFontSize);
  // SAFETY: CSS custom properties are valid inline styles; React's type lists only standard ones.
  const previewFontStyle = React.useMemo(() => ({
    '--text-markdown': `${editorFontSize + 2}px`,
    '--text-code': `${editorFontSize}px`,
  } as React.CSSProperties), [editorFontSize]);
  const editorCode = useEditorCodeMetrics();

  const selectedRelativePath = selectedFile?.path && root && selectedFile.path.startsWith(`${root}/`)
    ? selectedFile.path.slice(root.length + 1)
    : null;
  const selectedGitDirectory = useEffectiveGitDirectory(currentDirectory || null);
  const gitTarget = gitBaselineTarget(selectedFile?.path, currentDirectory, selectedGitDirectory);
  const gitDirectory = gitTarget?.directory ?? null;
  const gitRelativePath = gitTarget?.relativePath ?? null;
  const gitBaselineKey = useGitStore((state) => {
    if (!gitRelativePath || !gitDirectory) return null;
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
      codeSelectionComment.extension,
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
    } else {
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
  }, [currentTheme, selectedFile?.path, staticLanguageExtension, dynamicLanguageExtension, wrapLines, isMobile, nudgeEditorSelectionAboveKeyboard, editorFontSize, pinPreviewOnEditExtension, fileEditorKeymap, t, importLinksExtension, codeSelectionComment.extension]);

  const pierreTheme = React.useMemo(
    () => ({ light: ensurePierreThemeRegistered(lightTheme), dark: ensurePierreThemeRegistered(darkTheme) }),
    [lightTheme, darkTheme],
  );
  return {
  previewFontStyle, editorCode, applyGitBaseline, editorExtensions, pierreTheme,
  };
}

export function useFileEditorPanels({ editor, fileKinds, isMobile }: {
  editor: Pick<ReturnType<typeof useFileEditor>, 'editorViewRef' | 'isSearchOpen' | 'setIsGoToLineOpen' | 'setIsSymbolsOpen'>;
  fileKinds: Pick<ReturnType<typeof useFileKinds>, 'sourceEditorShown'>;
  isMobile: boolean;
}) {
  const { editorViewRef, isSearchOpen, setIsGoToLineOpen, setIsSymbolsOpen } = editor;
  const { sourceEditorShown } = fileKinds;
  React.useEffect(() => {
    const view = editorViewRef.current;
    if (!isMobile || !isSearchOpen || !view) return;
    const query = getSearchQuery(view.state);
    if (!query.caseSensitive && !query.regexp && !query.wholeWord) return;
    view.dispatch({ effects: setEditorSearchQuery.of(new SearchQuery({ search: query.search, replace: query.replace })) });
  }, [isMobile, isSearchOpen]);

  React.useEffect(() => {
    if (sourceEditorShown) return;
    setIsGoToLineOpen(false);
    setIsSymbolsOpen(false);
  }, [sourceEditorShown]);

  return {  };
}
