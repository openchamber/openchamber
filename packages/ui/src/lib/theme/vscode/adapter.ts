import type { Theme } from '@/types/theme';
import type { ThemeMode } from '@/types/theme';
import { getDefaultTheme } from '../themes';
import { contrastRatio, onColor, readableText, withOpacity } from '../color';

export type VSCodeThemeKind = 'light' | 'dark' | 'high-contrast';

type VSCodeThemeColorToken =
  // Editor core
  | 'editor.background'
  | 'editor.foreground'
  | 'editor.selectionBackground'
  | 'editor.selectionForeground'
  | 'editor.lineHighlightBackground'
  | 'editorCursor.foreground'
  // Chat
  | 'interactive-session.foreground'
  | 'chat.list.background'
  | 'chat.requestBorder'
  | 'chat.requestBackground'
  | 'chat.requestBubbleBackground'
  | 'chat.requestBubbleHoverBackground'
  | 'chat.avatarBackground'
  | 'chat.avatarForeground'
  | 'chat.slashCommandBackground'
  | 'chat.slashCommandForeground'
  | 'chat.editedFileForeground'
  | 'chat.requestCodeBorder'
  | 'chat.linesAddedForeground'
  | 'chat.linesRemovedForeground'
  | 'chat.thinkingShimmer'
  | 'chat.inputWorkingBorderColor1'
  | 'chat.inputWorkingBorderColor2'
  | 'chat.inputWorkingBorderColor3'
  | 'textBlockQuote.background'
  | 'textBlockQuote.border'
  | 'toolbar.hoverBackground'
  | 'toolbar.activeBackground'
  | 'toolbar.hoverOutline'
  | 'icon.foreground'
  | 'inputOption.activeForeground'
  | 'inputOption.activeBorder'
  | 'inputOption.activeBackground'
  | 'notificationsWarningIcon.foreground'
  | 'problemsWarningIcon.foreground'
  | 'problemsInfoIcon.foreground'
  // UI borders and focus
  | 'focusBorder'
  | 'contrastBorder'
  | 'widget.border'
  // Diff editor
  | 'diffEditor.insertedTextBackground'
  | 'diffEditor.insertedTextBorder'
  | 'diffEditor.insertedLineBackground'
  | 'diffEditor.removedTextBackground'
  | 'diffEditor.removedLineBackground'
  | 'gitDecoration.addedResourceForeground'
  | 'gitDecoration.deletedResourceForeground'
  | 'gitDecoration.modifiedResourceForeground'
  // Sidebar
  | 'sideBar.background'
  | 'sideBar.foreground'
  | 'sideBar.border'
  // Panel (bottom area)
  | 'panel.background'
  | 'panel.foreground'
  | 'panel.border'
  // Inputs
  | 'input.background'
  | 'input.foreground'
  | 'input.border'
  | 'input.placeholderForeground'
  // Buttons
  | 'button.background'
  | 'button.foreground'
  | 'button.hoverBackground'
  | 'button.secondaryBackground'
  | 'button.secondaryForeground'
  // Text
  | 'textLink.foreground'
  | 'textLink.activeForeground'
  | 'descriptionForeground'
  | 'foreground'
  // Terminal colors (for syntax)
  | 'terminal.ansiRed'
  | 'terminal.ansiGreen'
  | 'terminal.ansiBlue'
  | 'terminal.ansiYellow'
  | 'terminal.ansiCyan'
  | 'terminal.ansiMagenta'
  // Editor diagnostics
  | 'editorError.foreground'
  | 'editorError.background'
  | 'editorWarning.foreground'
  | 'editorWarning.background'
  | 'editorInfo.foreground'
  | 'editorInfo.background'
  // Testing
  | 'testing.iconPassed'
  | 'testing.iconFailed'
  // Badge
  | 'badge.background'
  | 'badge.foreground'
  // Status bar
  | 'statusBar.background'
  | 'statusBar.foreground'
  // Lists
  | 'list.hoverBackground'
  | 'list.activeSelectionBackground'
  | 'list.activeSelectionForeground'
  | 'list.inactiveSelectionBackground'
  | 'menu.selectionBackground'
  | 'menu.selectionForeground'
  // Preformatted text (code)
  | 'textPreformat.foreground'
  | 'textPreformat.background'
  | 'textPreformat.border'
  // Editor widgets
  | 'editorWidget.background'
  | 'editorWidget.foreground'
  | 'editorWidget.border'
  // Dropdown
  | 'dropdown.background'
  | 'dropdown.foreground'
  | 'dropdown.border'
  // Editor gutter
  | 'editorLineNumber.foreground'
  | 'editorLineNumber.activeForeground'
  // Scrollbar
  | 'scrollbarSlider.background'
  | 'scrollbarSlider.hoverBackground';

export type VSCodeThemePalette = {
  kind: VSCodeThemeKind;
  colors: Partial<Record<VSCodeThemeColorToken, string>>;
  mode?: ThemeMode;
};

export type VSCodeThemePayload = {
  theme: Theme;
  palette: VSCodeThemePalette;
};

const VARIABLE_MAP: Record<VSCodeThemeColorToken, string> = {
  // Editor core
  'editor.background': '--vscode-editor-background',
  'editor.foreground': '--vscode-editor-foreground',
  'editor.selectionBackground': '--vscode-editor-selectionBackground',
  'editor.selectionForeground': '--vscode-editor-selectionForeground',
  'editor.lineHighlightBackground': '--vscode-editor-lineHighlightBackground',
  'editorCursor.foreground': '--vscode-editorCursor-foreground',
  // Chat
  'interactive-session.foreground': '--vscode-interactive-session-foreground',
  'chat.list.background': '--vscode-chat-list-background',
  'chat.requestBorder': '--vscode-chat-requestBorder',
  'chat.requestBackground': '--vscode-chat-requestBackground',
  'chat.requestBubbleBackground': '--vscode-chat-requestBubbleBackground',
  'chat.requestBubbleHoverBackground': '--vscode-chat-requestBubbleHoverBackground',
  'chat.avatarBackground': '--vscode-chat-avatarBackground',
  'chat.avatarForeground': '--vscode-chat-avatarForeground',
  'chat.slashCommandBackground': '--vscode-chat-slashCommandBackground',
  'chat.slashCommandForeground': '--vscode-chat-slashCommandForeground',
  'chat.editedFileForeground': '--vscode-chat-editedFileForeground',
  'chat.requestCodeBorder': '--vscode-chat-requestCodeBorder',
  'chat.linesAddedForeground': '--vscode-chat-linesAddedForeground',
  'chat.linesRemovedForeground': '--vscode-chat-linesRemovedForeground',
  'chat.thinkingShimmer': '--vscode-chat-thinkingShimmer',
  'chat.inputWorkingBorderColor1': '--vscode-chat-inputWorkingBorderColor1',
  'chat.inputWorkingBorderColor2': '--vscode-chat-inputWorkingBorderColor2',
  'chat.inputWorkingBorderColor3': '--vscode-chat-inputWorkingBorderColor3',
  'textBlockQuote.background': '--vscode-textBlockQuote-background',
  'textBlockQuote.border': '--vscode-textBlockQuote-border',
  'toolbar.hoverBackground': '--vscode-toolbar-hoverBackground',
  'toolbar.activeBackground': '--vscode-toolbar-activeBackground',
  'toolbar.hoverOutline': '--vscode-toolbar-hoverOutline',
  'icon.foreground': '--vscode-icon-foreground',
  'inputOption.activeForeground': '--vscode-inputOption-activeForeground',
  'inputOption.activeBorder': '--vscode-inputOption-activeBorder',
  'inputOption.activeBackground': '--vscode-inputOption-activeBackground',
  'notificationsWarningIcon.foreground': '--vscode-notificationsWarningIcon-foreground',
  'problemsWarningIcon.foreground': '--vscode-problemsWarningIcon-foreground',
  'problemsInfoIcon.foreground': '--vscode-problemsInfoIcon-foreground',
  // UI borders and focus
  focusBorder: '--vscode-focusBorder',
  contrastBorder: '--vscode-contrastBorder',
  'widget.border': '--vscode-widget-border',
  // Diff editor
  'diffEditor.insertedTextBackground': '--vscode-diffEditor-insertedTextBackground',
  'diffEditor.insertedTextBorder': '--vscode-diffEditor-insertedTextBorder',
  'diffEditor.insertedLineBackground': '--vscode-diffEditor-insertedLineBackground',
  'diffEditor.removedTextBackground': '--vscode-diffEditor-removedTextBackground',
  'diffEditor.removedLineBackground': '--vscode-diffEditor-removedLineBackground',
  'gitDecoration.addedResourceForeground': '--vscode-gitDecoration-addedResourceForeground',
  'gitDecoration.deletedResourceForeground': '--vscode-gitDecoration-deletedResourceForeground',
  'gitDecoration.modifiedResourceForeground': '--vscode-gitDecoration-modifiedResourceForeground',
  // Sidebar
  'sideBar.background': '--vscode-sideBar-background',
  'sideBar.foreground': '--vscode-sideBar-foreground',
  'sideBar.border': '--vscode-sideBar-border',
  // Panel
  'panel.background': '--vscode-panel-background',
  'panel.foreground': '--vscode-panel-foreground',
  'panel.border': '--vscode-panel-border',
  // Inputs
  'input.background': '--vscode-input-background',
  'input.foreground': '--vscode-input-foreground',
  'input.border': '--vscode-input-border',
  'input.placeholderForeground': '--vscode-input-placeholderForeground',
  // Buttons
  'button.background': '--vscode-button-background',
  'button.foreground': '--vscode-button-foreground',
  'button.hoverBackground': '--vscode-button-hoverBackground',
  'button.secondaryBackground': '--vscode-button-secondaryBackground',
  'button.secondaryForeground': '--vscode-button-secondaryForeground',
  // Text
  'textLink.foreground': '--vscode-textLink-foreground',
  'textLink.activeForeground': '--vscode-textLink-activeForeground',
  descriptionForeground: '--vscode-descriptionForeground',
  foreground: '--vscode-foreground',
  // Terminal
  'terminal.ansiRed': '--vscode-terminal-ansiRed',
  'terminal.ansiGreen': '--vscode-terminal-ansiGreen',
  'terminal.ansiBlue': '--vscode-terminal-ansiBlue',
  'terminal.ansiYellow': '--vscode-terminal-ansiYellow',
  'terminal.ansiCyan': '--vscode-terminal-ansiCyan',
  'terminal.ansiMagenta': '--vscode-terminal-ansiMagenta',
  // Diagnostics
  'editorError.foreground': '--vscode-editorError-foreground',
  'editorError.background': '--vscode-editorError-background',
  'editorWarning.foreground': '--vscode-editorWarning-foreground',
  'editorWarning.background': '--vscode-editorWarning-background',
  'editorInfo.foreground': '--vscode-editorInfo-foreground',
  'editorInfo.background': '--vscode-editorInfo-background',
  // Testing
  'testing.iconPassed': '--vscode-testing-iconPassed',
  'testing.iconFailed': '--vscode-testing-iconFailed',
  // Badge
  'badge.background': '--vscode-badge-background',
  'badge.foreground': '--vscode-badge-foreground',
  // Status bar
  'statusBar.background': '--vscode-statusBar-background',
  'statusBar.foreground': '--vscode-statusBar-foreground',
  // Lists
  'list.hoverBackground': '--vscode-list-hoverBackground',
  'list.activeSelectionBackground': '--vscode-list-activeSelectionBackground',
  'list.activeSelectionForeground': '--vscode-list-activeSelectionForeground',
  'list.inactiveSelectionBackground': '--vscode-list-inactiveSelectionBackground',
  'menu.selectionBackground': '--vscode-menu-selectionBackground',
  'menu.selectionForeground': '--vscode-menu-selectionForeground',
  // Preformat
  'textPreformat.foreground': '--vscode-textPreformat-foreground',
  'textPreformat.background': '--vscode-textPreformat-background',
  'textPreformat.border': '--vscode-textPreformat-border',
  // Editor widgets
  'editorWidget.background': '--vscode-editorWidget-background',
  'editorWidget.foreground': '--vscode-editorWidget-foreground',
  'editorWidget.border': '--vscode-editorWidget-border',
  // Dropdown
  'dropdown.background': '--vscode-dropdown-background',
  'dropdown.foreground': '--vscode-dropdown-foreground',
  'dropdown.border': '--vscode-dropdown-border',
  // Editor gutter
  'editorLineNumber.foreground': '--vscode-editorLineNumber-foreground',
  'editorLineNumber.activeForeground': '--vscode-editorLineNumber-activeForeground',
  // Scrollbar
  'scrollbarSlider.background': '--vscode-scrollbarSlider-background',
  'scrollbarSlider.hoverBackground': '--vscode-scrollbarSlider-hoverBackground',
};

const normalizeColor = (value?: string | null): string | undefined => {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
};

const applyAlpha = withOpacity;

const readKind = (preferred?: VSCodeThemeKind): VSCodeThemeKind => {
  if (preferred === 'light' || preferred === 'dark' || preferred === 'high-contrast') {
    return preferred;
  }

  if (typeof window !== 'undefined') {
    const prefersLight = typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: light)').matches;
    return prefersLight ? 'light' : 'dark';
  }

  return 'dark';
};

export const readVSCodeThemePalette = (
  preferredKind?: VSCodeThemeKind,
  preferredMode?: ThemeMode,
): VSCodeThemePalette | null => {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }

  const rootStyles = getComputedStyle(document.documentElement);
  const bodyStyles = document.body ? getComputedStyle(document.body) : null;
  const colors: Partial<Record<VSCodeThemeColorToken, string>> = {};

  (Object.keys(VARIABLE_MAP) as VSCodeThemeColorToken[]).forEach((token) => {
    const cssVar = VARIABLE_MAP[token];
    const value = normalizeColor(rootStyles.getPropertyValue(cssVar))
      ?? (bodyStyles ? normalizeColor(bodyStyles.getPropertyValue(cssVar)) : undefined);
    if (value) {
      colors[token] = value;
    }
  });

  return {
    kind: readKind(preferredKind),
    colors,
    mode: preferredMode,
  };
};

export const buildVSCodeThemeFromPalette = (palette: VSCodeThemePalette): Theme => {
  const isDark = palette.kind === 'dark' || palette.kind === 'high-contrast';
  const base = getDefaultTheme(isDark);
  
  const read = (token: VSCodeThemeColorToken, fallback: string): string =>
    palette.colors[token] ?? fallback;
  const hasPaint = (value: string) => value !== 'transparent'
    && (contrastRatio(value, '#000000') !== 1 || contrastRatio(value, '#ffffff') !== 1);
  const readPaint = (token: VSCodeThemeColorToken, fallback: string) => {
    const value = read(token, fallback);
    return hasPaint(value) ? value : fallback;
  };

  // ===========================================
  // SURFACE COLORS - Layered backgrounds
  // ===========================================
  
  // The transcript is the main canvas. Sidebar and selection colors belong to
  // their own roles, even when the source palette happens to make them equal.
  const background = read('chat.list.background', read('editor.background', base.colors.surface.background));
  
  // Main foreground text color
  const foreground = read('interactive-session.foreground', read('foreground', read('editor.foreground', base.colors.surface.foreground)));
  
  // OpenChamber deliberately shares elevated between fields and floating UI.
  // Prefer a floating widget pair, then dropdown/input pairs. Keep the matching
  // foreground with the chosen background; do not mix unrelated VS Code roles.
  const elevatedSources = [
    ['editorWidget.background', 'editorWidget.foreground'],
    ['dropdown.background', 'dropdown.foreground'],
    ['input.background', 'input.foreground'],
  ] as const;
  const elevatedSource = elevatedSources.find(([key]) => palette.colors[key]);
  const elevated = elevatedSource ? read(elevatedSource[0], base.colors.surface.elevated) : base.colors.surface.elevated;
  const elevatedTextFallback = readableText(foreground, elevated, background);
  const elevatedForeground = elevatedSource ? read(elevatedSource[1], elevatedTextFallback) : elevatedTextFallback;
  
  // Secondary layout areas are surfaces, not inactive selections or bubbles.
  const muted = read('sideBar.background', read('panel.background', base.colors.surface.muted));
  
  // Muted foreground: secondary text - description foreground is perfect semantic match
  const mutedForeground = read('descriptionForeground', read('input.placeholderForeground', base.colors.surface.mutedForeground));
  
  const subtle = read('textBlockQuote.background', muted);
  
  // VS Code's status bar is a surface, not a modal backdrop.
  const overlay = base.colors.surface.overlay;

  // ===========================================
  // PRIMARY / ACCENT COLORS
  // ===========================================
  
  const accent = read('button.background', read('textLink.foreground', base.colors.primary.base));
  const accentHover = read('button.hoverBackground', accent);
  const accentForeground = palette.colors['button.background']
    ? read('button.foreground', onColor(accent, background))
    : onColor(accent, background);
  const accentMuted = applyAlpha(accent, 0.5);

  // ===========================================
  // INTERACTIVE COLORS
  // ===========================================
  
  // Border: Use widget.border (most generic), then input.border, panel.border
  // DO NOT reduce opacity - these are already properly set by VS Code themes
  const border = [
    palette.kind === 'high-contrast' ? read('contrastBorder', '') : '',
    read('widget.border', ''), read('input.border', ''),
    read('panel.border', ''), read('sideBar.border', ''),
    read('editorWidget.border', ''), read('contrastBorder', ''),
  ].find((value) => value && hasPaint(value));
  
  // For high-contrast or missing borders, derive from foreground
  const effectiveBorder = border || applyAlpha(foreground, isDark ? 0.25 : 0.2);
  
  // Hover/active backgrounds
  const hoverBg = read('toolbar.hoverBackground', read('list.hoverBackground', base.colors.interactive.hover));
  const activeBg = read('toolbar.activeBackground', hoverBg);
  
  // Selection
  // A sidebar selection can equal the floating-widget background. Prefer an
  // authored pair that remains distinguishable on all three shared surfaces.
  const selectionSources = [
    ['list.activeSelectionBackground', 'list.activeSelectionForeground'],
    ['menu.selectionBackground', 'menu.selectionForeground'],
    ['editor.selectionBackground', 'editor.selectionForeground'],
  ] as const;
  const candidates = selectionSources.filter(([token]) => palette.colors[token]);
  const selectionSource = candidates.find(([token]) => [background, muted, elevated].every((surface) => {
    const contrast = contrastRatio(read(token, ''), surface, background);
    return contrast === null || contrast > 1.01;
  })) ?? candidates[0];
  const selection = selectionSource ? read(selectionSource[0], base.colors.interactive.selection) : base.colors.interactive.selection;
  const selectionForeground = selectionSource ? read(selectionSource[1], foreground) : foreground;
  
  // Focus
  const focus = read('focusBorder', read('inputOption.activeBorder', accent));
  const focusRing = focus;
  
  // Cursor
  const cursor = read('editorCursor.foreground', base.colors.interactive.cursor);

  // ===========================================
  // STATUS COLORS
  // ===========================================
  
  const errorColor = read('editorError.foreground', read('testing.iconFailed', base.colors.status.error));
  const errorBg = readPaint('editorError.background', applyAlpha(errorColor, isDark ? 0.16 : 0.12));
  
  const warningColor = read('problemsWarningIcon.foreground', read('notificationsWarningIcon.foreground', read('editorWarning.foreground', base.colors.status.warning)));
  const warningBg = readPaint('editorWarning.background', applyAlpha(warningColor, isDark ? 0.16 : 0.12));
  
  const successColor = read('testing.iconPassed', read('gitDecoration.addedResourceForeground', base.colors.status.success));
  const successBg = applyAlpha(successColor, isDark ? 0.16 : 0.12);
  
  const infoColor = read('problemsInfoIcon.foreground', read('editorInfo.foreground', base.colors.status.info));
  const infoBg = readPaint('editorInfo.background', applyAlpha(infoColor, isDark ? 0.16 : 0.12));

  // ===========================================
  // SYNTAX / CODE COLORS
  // ===========================================
  
  const syntaxComment = read('editorLineNumber.foreground', mutedForeground);
  const syntaxString = read('textPreformat.foreground', read('terminal.ansiGreen', base.colors.syntax.base.string));
  const syntaxKeyword = read('terminal.ansiBlue', accent);
  const syntaxNumber = read('terminal.ansiYellow', base.colors.syntax.base.number);
  const syntaxFunction = read('terminal.ansiCyan', base.colors.syntax.base.function);
  const syntaxVariable = read('terminal.ansiMagenta', foreground);
  const syntaxType = read('terminal.ansiYellow', base.colors.syntax.base.type);

  // ===========================================
  // TOOLS SECTION - For tool cards, diffs, etc.
  // ===========================================
  
  // Tools border should be visible! Use border directly without extra opacity reduction
  const toolsBorder = read('chat.requestBorder', effectiveBorder);
  
  // Diff colors from VS Code diff editor
  const diffAddedBg = read('diffEditor.insertedLineBackground', read('diffEditor.insertedTextBackground', successBg));
  const diffRemovedBg = read('diffEditor.removedLineBackground', read('diffEditor.removedTextBackground', errorBg));
  const diffAddedColor = read('chat.linesAddedForeground', read('gitDecoration.addedResourceForeground', successColor));
  const diffRemovedColor = read('chat.linesRemovedForeground', read('gitDecoration.deletedResourceForeground', errorColor));
  const diffModifiedColor = read('gitDecoration.modifiedResourceForeground', infoColor);

  // ===========================================
  // CHAT COLORS
  // ===========================================
  
  // Prefer the authored chat bubble, with an elevated surface as the fallback.
  const userMessageBg = read('chat.requestBubbleBackground', read('chat.requestBackground', elevated));
  
  return {
    ...base,
    metadata: {
      ...base.metadata,
      id: 'vscode-auto',
      name: 'VS Code Theme',
      description: 'Mirrors your current VS Code color theme',
      author: 'VS Code',
      version: '1.0.0',
      variant: isDark ? 'dark' : 'light',
      tags: ['vscode', 'auto'],
    },
    colors: {
      ...base.colors,
      primary: {
        base: accent,
        hover: accentHover,
        active: accentHover,
        foreground: accentForeground,
        muted: accentMuted,
      },
      surface: {
        background,
        foreground,
        muted,
        mutedForeground,
        elevated,
        elevatedForeground,
        overlay,
        subtle,
      },
      interactive: {
        border: effectiveBorder,
        borderHover: read('toolbar.hoverOutline', effectiveBorder),
        borderFocus: focus,
        selection,
        selectionForeground,
        focus,
        focusRing,
        cursor,
        hover: hoverBg,
        active: activeBg,
      },
      status: {
        error: errorColor,
        errorForeground: onColor(errorColor, background),
        errorBackground: errorBg,
        errorBorder: applyAlpha(errorColor, isDark ? 0.45 : 0.35),
        warning: warningColor,
        warningForeground: onColor(warningColor, background),
        warningBackground: warningBg,
        warningBorder: applyAlpha(warningColor, isDark ? 0.45 : 0.35),
        success: successColor,
        successForeground: onColor(successColor, background),
        successBackground: successBg,
        successBorder: applyAlpha(successColor, isDark ? 0.45 : 0.35),
        info: infoColor,
        infoForeground: onColor(infoColor, background),
        infoBackground: infoBg,
        infoBorder: applyAlpha(infoColor, isDark ? 0.45 : 0.35),
      },
      syntax: {
        tokens: {},
        highlights: {
          diffAdded: diffAddedColor,
          diffAddedBackground: diffAddedBg,
          diffRemoved: diffRemovedColor,
          diffRemovedBackground: diffRemovedBg,
          diffModified: diffModifiedColor,
          diffModifiedBackground: applyAlpha(diffModifiedColor, isDark ? 0.16 : 0.12),
          lineNumber: read('editorLineNumber.foreground', mutedForeground),
          lineNumberActive: read('editorLineNumber.activeForeground', foreground),
        },
        base: {
          background: read('editor.background', background),
          foreground: read('editor.foreground', foreground),
          comment: syntaxComment,
          keyword: syntaxKeyword,
          string: syntaxString,
          number: syntaxNumber,
          function: syntaxFunction,
          variable: syntaxVariable,
          type: syntaxType,
          operator: accent,
        },
      },
      // Explicit tools section - cssGenerator will use these values directly
      tools: {
        border: toolsBorder,
        icon: read('icon.foreground', mutedForeground),
        title: foreground,
        description: applyAlpha(mutedForeground, 0.8),
        edit: {
          added: diffAddedColor,
          addedBackground: diffAddedBg,
          removed: diffRemovedColor,
          removedBackground: diffRemovedBg,
          modified: diffModifiedColor,
          modifiedBackground: applyAlpha(diffModifiedColor, isDark ? 0.16 : 0.12),
          lineNumber: syntaxComment,
        },
      },
      // Explicit chat section
      chat: {
        background,
        userMessage: foreground,
        userMessageBackground: userMessageBg,
        assistantMessage: foreground,
        assistantMessageBackground: background,
        timestamp: mutedForeground,
        divider: effectiveBorder,
        typing: read('chat.thinkingShimmer', mutedForeground),
        avatarBackground: read('chat.avatarBackground', background),
        avatarForeground: read('chat.avatarForeground', foreground),
        slashCommandBackground: read('chat.slashCommandBackground', accent),
        slashCommandForeground: read('chat.slashCommandForeground', accentForeground),
        inputWorkingBorderColor1: read('chat.inputWorkingBorderColor1', accent),
        inputWorkingBorderColor2: read('chat.inputWorkingBorderColor2', accentHover),
        inputWorkingBorderColor3: read('chat.inputWorkingBorderColor3', accentMuted),
      },
      // Markdown colors
      markdown: {
        link: read('textLink.foreground', accent),
        linkHover: read('textLink.activeForeground', accentHover),
        inlineCode: read('textPreformat.foreground', syntaxString),
        inlineCodeBackground: read('textPreformat.background', read('editor.background', background)),
        blockquote: foreground,
        blockquoteBackground: read('textBlockQuote.background', 'transparent'),
        blockquoteBorder: read('textBlockQuote.border', effectiveBorder),
        listMarker: applyAlpha(accent, 0.6),
      },
    },
  };
};
