import type { Theme } from '@/types/theme';
import type { ThemeMode } from '@/types/theme';
import { getDefaultTheme } from '@/lib/theme/themes';

export type VSCodeThemeKind = 'light' | 'dark' | 'high-contrast';

export type VSCodeThemeColorToken =
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

const applyAlpha = (color: string, opacity: number): string => {
  const normalized = color.trim();
  if (!normalized) return color;

  // rgba()/rgb()
  const rgbMatch = normalized.match(
    /^rgba?\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})(?:\s*,\s*([0-9.]+))?\s*\)$/i,
  );
  if (rgbMatch) {
    const r = Math.min(255, Math.max(0, Number(rgbMatch[1])));
    const g = Math.min(255, Math.max(0, Number(rgbMatch[2])));
    const b = Math.min(255, Math.max(0, Number(rgbMatch[3])));
    return `rgba(${r}, ${g}, ${b}, ${opacity})`;
  }

  // #RGB / #RRGGBB / #RRGGBBAA
  const hex = normalized.replace(/^#/, '');
  if (hex.length === 3 || hex.length === 6 || hex.length === 8) {
    const expanded = hex.length === 3
      ? hex.split('').map((c) => `${c}${c}`).join('')
      : hex.length === 8
        ? hex.slice(0, 6)
        : hex;

    const r = parseInt(expanded.slice(0, 2), 16);
    const g = parseInt(expanded.slice(2, 4), 16);
    const b = parseInt(expanded.slice(4, 6), 16);
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    }
  }

  return color;
};

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
  const base = getDefaultTheme(palette.kind === 'dark');
  const isDark = palette.kind === 'dark' || palette.kind === 'high-contrast';
  
  const read = (token: VSCodeThemeColorToken, fallback: string): string =>
    palette.colors[token] ?? fallback;

  // ===========================================
  // SURFACE COLORS - Layered backgrounds
  // ===========================================
  
  // Main chat background: match VS Code's chat list first, then fall back to shell surfaces.
  const background = read('chat.list.background', read('sideBar.background', base.colors.surface.background));
  
  // Main foreground text color
  const foreground = read('interactive-session.foreground', read('foreground', read('editor.foreground', base.colors.surface.foreground)));
  
  // Elevated surfaces: panels, cards, dialogs - use editorWidget or panel
  const elevated = read('editorWidget.background', read('panel.background', read('editor.background', base.colors.surface.elevated)));
  const elevatedForeground = read('editorWidget.foreground', read('panel.foreground', foreground));
  
  // Muted background: used for inactive/deemphasized areas - use list inactive selection
  const muted = read('chat.requestBackground', read('list.inactiveSelectionBackground', read('editor.lineHighlightBackground', base.colors.surface.muted)));
  
  // Muted foreground: secondary text - description foreground is perfect semantic match
  const mutedForeground = read('descriptionForeground', read('input.placeholderForeground', base.colors.surface.mutedForeground));
  
  // Subtle: used for input backgrounds, user message bubbles - input.background is the semantic match
  const subtle = read('input.background', read('dropdown.background', elevated));
  
  // Overlay: modal backdrops, status bar
  const overlay = read('statusBar.background', base.colors.surface.overlay);

  // ===========================================
  // PRIMARY / ACCENT COLORS
  // ===========================================
  
  const accent = read('button.background', read('textLink.foreground', base.colors.primary.base));
  const accentHover = read('button.hoverBackground', accent);
  const accentForeground = read('button.foreground', base.colors.primary.foreground || background);
  const accentMuted = read('textLink.foreground', accent);

  // ===========================================
  // INTERACTIVE COLORS
  // ===========================================
  
  // Border: Use widget.border (most generic), then input.border, panel.border
  // DO NOT reduce opacity - these are already properly set by VS Code themes
  const border = read('chat.requestBorder', '') ||
    read('widget.border', '') ||
    read('input.border', '') ||
    read('panel.border', '') ||
    read('sideBar.border', '') ||
    read('contrastBorder', base.colors.interactive.border);
  
  // For high-contrast or missing borders, derive from foreground
  const effectiveBorder = border || applyAlpha(foreground, isDark ? 0.25 : 0.2);
  
  // Hover/active backgrounds
  const hoverBg = read('toolbar.hoverBackground', read('chat.requestBubbleHoverBackground', read('list.hoverBackground', base.colors.interactive.hover)));
  const activeBg = read('toolbar.activeBackground', read('inputOption.activeBackground', read('list.activeSelectionBackground', hoverBg)));
  
  // Selection
  const selection = read('editor.selectionBackground', base.colors.interactive.selection);
  const selectionForeground = read('editor.selectionForeground', read('list.activeSelectionForeground', foreground));
  
  // Focus
  const focus = read('focusBorder', read('inputOption.activeBorder', accent));
  const focusRing = applyAlpha(focus, isDark ? 0.45 : 0.35);
  
  // Cursor
  const cursor = read('editorCursor.foreground', base.colors.interactive.cursor);

  // ===========================================
  // STATUS COLORS
  // ===========================================
  
  const errorColor = read('editorError.foreground', read('testing.iconFailed', base.colors.status.error));
  const errorBg = read('editorError.background', applyAlpha(errorColor, isDark ? 0.16 : 0.12));
  
  const warningColor = read('problemsWarningIcon.foreground', read('notificationsWarningIcon.foreground', read('editorWarning.foreground', base.colors.status.warning)));
  const warningBg = read('editorWarning.background', applyAlpha(warningColor, isDark ? 0.16 : 0.12));
  
  const successColor = read('testing.iconPassed', read('gitDecoration.addedResourceForeground', base.colors.status.success));
  const successBg = applyAlpha(successColor, isDark ? 0.16 : 0.12);
  
  const infoColor = read('problemsInfoIcon.foreground', read('editorInfo.foreground', base.colors.status.info));
  const infoBg = read('editorInfo.background', applyAlpha(infoColor, isDark ? 0.16 : 0.12));

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
  const toolsBackground = read('editor.background', applyAlpha(muted, 0.5));
  const toolsHeaderHover = read('toolbar.hoverBackground', applyAlpha(hoverBg, 0.5));
  
  // Diff colors from VS Code diff editor
  const diffAddedBg = read('diffEditor.insertedLineBackground', read('diffEditor.insertedTextBackground', successBg));
  const diffRemovedBg = read('diffEditor.removedLineBackground', read('diffEditor.removedTextBackground', errorBg));
  const diffAddedColor = read('chat.linesAddedForeground', read('gitDecoration.addedResourceForeground', successColor));
  const diffRemovedColor = read('chat.linesRemovedForeground', read('gitDecoration.deletedResourceForeground', errorColor));
  const diffModifiedColor = read('gitDecoration.modifiedResourceForeground', infoColor);

  // ===========================================
  // BADGES
  // ===========================================
  
  const badgeBg = read('badge.background', accent);
  const badgeFg = read('badge.foreground', accentForeground);

  // ===========================================
  // CHAT COLORS
  // ===========================================
  
  // User messages: same as chat input (subtle surface)
  const userMessageBg = read('chat.requestBubbleBackground', read('chat.requestBackground', subtle));
  
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
        emphasis: accent,
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
        selectionForeground: read('inputOption.activeForeground', selectionForeground),
        focus,
        focusRing,
        cursor,
        hover: hoverBg,
        active: activeBg,
      },
      status: {
        error: errorColor,
        errorForeground: errorColor,
        errorBackground: errorBg,
        errorBorder: applyAlpha(errorColor, isDark ? 0.45 : 0.35),
        warning: warningColor,
        warningForeground: warningColor,
        warningBackground: warningBg,
        warningBorder: applyAlpha(warningColor, isDark ? 0.45 : 0.35),
        success: successColor,
        successForeground: successColor,
        successBackground: successBg,
        successBorder: applyAlpha(successColor, isDark ? 0.45 : 0.35),
        info: infoColor,
        infoForeground: infoColor,
        infoBackground: infoBg,
        infoBorder: applyAlpha(infoColor, isDark ? 0.45 : 0.35),
      },
      syntax: {
        ...base.colors.syntax,
        base: {
          background: elevated,
          foreground,
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
        background: toolsBackground,
        border: toolsBorder,
        headerHover: toolsHeaderHover,
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
      // Badges
      badges: {
        ...(base.colors.badges || {}),
        default: {
          bg: badgeBg,
          fg: badgeFg,
          border: effectiveBorder,
        },
      },
      // Markdown colors
      markdown: {
        heading1: foreground,
        heading2: foreground,
        heading3: foreground,
        heading4: foreground,
        link: accentMuted,
        linkHover: read('textLink.activeForeground', accentHover),
        inlineCode: read('textPreformat.foreground', syntaxString),
        inlineCodeBackground: subtle,
        inlineCodeBorder: read('textPreformat.border', read('chat.requestCodeBorder', effectiveBorder)),
        blockquote: foreground,
        blockquoteBackground: read('textBlockQuote.background', 'transparent'),
        blockquoteBorder: read('textBlockQuote.border', effectiveBorder),
        listMarker: applyAlpha(accent, 0.6),
      },
      // Scrollbar
      scrollbar: {
        track: 'transparent',
        thumb: read('scrollbarSlider.background', applyAlpha(foreground, isDark ? 0.2 : 0.15)),
        thumbHover: read('scrollbarSlider.hoverBackground', applyAlpha(foreground, isDark ? 0.35 : 0.25)),
      },
    },
  };
};
