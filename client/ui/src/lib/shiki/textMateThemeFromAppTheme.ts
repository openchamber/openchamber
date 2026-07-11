import type { Theme } from '@/types/theme';

import type { VSCodeTextMateTheme, VSCodeTokenColorRule } from './vscodeTextMateTheme';

const isHex6 = (value: string): boolean => /^#[0-9a-fA-F]{6}$/.test(value);
const isHex8 = (value: string): boolean => /^#[0-9a-fA-F]{8}$/.test(value);

const addAlpha = (value: string, alphaHex: string): string => {
  if (!/^[0-9a-fA-F]{2}$/.test(alphaHex)) {
    return value;
  }

  if (isHex6(value)) {
    return `${value}${alphaHex}`;
  }

  if (isHex8(value)) {
    return `${value.slice(0, 7)}${alphaHex}`;
  }

  return value;
};

const pick = (value: string | undefined, fallback: string): string => {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  return fallback;
};

const buildTokenColors = (theme: Theme): VSCodeTokenColorRule[] => {
  const base = theme.colors.syntax.base;
  const tokens = theme.colors.syntax.tokens ?? {};

  const t = (key: string, fallback: string): string => pick(tokens[key], fallback);

  return [
    {
      name: 'plain',
      scope: ['source', 'support.type.property-name.css'],
      settings: { foreground: base.foreground },
    },
    {
      name: 'classes',
      scope: ['entity.name.type.class'],
      settings: { foreground: t('className', t('class', base.function)) },
    },
    {
      name: 'interfaces',
      scope: ['entity.name.type.interface', 'entity.name.type'],
      settings: { foreground: t('interface', base.type) },
    },
    {
      name: 'structs',
      scope: ['entity.name.type.struct'],
      settings: { foreground: t('struct', base.function) },
    },
    {
      name: 'enums',
      scope: ['entity.name.type.enum'],
      settings: { foreground: t('enum', base.function) },
    },
    {
      name: 'keys',
      scope: ['meta.object-literal.key', 'support.type.property-name'],
      settings: { foreground: t('key', base.function) },
    },
    {
      name: 'methods',
      scope: ['entity.name.function.method', 'meta.function.method'],
      settings: { foreground: t('method', theme.colors.status.success) },
    },
    {
      name: 'functions',
      scope: ['entity.name.function', 'support.function', 'meta.function-call.generic'],
      settings: { foreground: base.function, fontStyle: 'bold' },
    },
    {
      name: 'variables',
      scope: ['variable', 'meta.variable', 'variable.other.object.property'],
      settings: { foreground: base.variable },
    },
    {
      name: 'variablesOther',
      scope: ['variable.other.object', 'variable.other.readwrite.alias'],
      settings: { foreground: t('variableOther', t('method', theme.colors.status.success)) },
    },
    {
      name: 'globalVariables',
      scope: ['variable.other.global', 'variable.language.this'],
      settings: { foreground: t('variableGlobal', base.number) },
    },
    {
      name: 'localVariables',
      scope: ['variable.other.local'],
      settings: { foreground: t('variableLocal', theme.colors.surface.elevated) },
    },
    {
      name: 'parameters',
      scope: ['variable.parameter', 'meta.parameter'],
      settings: { foreground: t('parameter', base.foreground) },
    },
    {
      name: 'properties',
      scope: ['variable.other.property', 'meta.property'],
      settings: { foreground: t('variableProperty', theme.colors.status.info) },
    },
    {
      name: 'strings',
      scope: ['string', 'string.other.link', 'markup.inline.raw.string.markdown'],
      settings: { foreground: base.string },
    },
    {
      name: 'stringEscapeSequences',
      scope: ['constant.character.escape', 'constant.other.placeholder'],
      settings: { foreground: t('stringEscape', base.foreground) },
    },
    {
      name: 'keywords',
      scope: ['keyword'],
      settings: { foreground: base.keyword },
    },
    {
      name: 'keywordsControl',
      scope: ['keyword.control.import', 'keyword.control.from', 'keyword.import'],
      settings: { foreground: t('keywordImport', base.operator) },
    },
    {
      name: 'storageModifiers',
      scope: ['storage.modifier', 'keyword.modifier', 'storage.type'],
      settings: { foreground: t('storageModifier', base.keyword) },
    },
    {
      name: 'comments',
      scope: ['comment', 'punctuation.definition.comment'],
      settings: { foreground: base.comment },
    },
    {
      name: 'docComments',
      scope: ['comment.documentation', 'comment.line.documentation'],
      settings: { foreground: t('commentDoc', theme.colors.surface.mutedForeground) },
    },
    {
      name: 'numbers',
      scope: ['constant.numeric'],
      settings: { foreground: base.number },
    },
    {
      name: 'booleans',
      scope: ['constant.language.boolean', 'constant.language.json'],
      settings: { foreground: t('boolean', base.type) },
    },
    {
      name: 'operators',
      scope: ['keyword.operator'],
      settings: { foreground: base.operator },
    },
    {
      name: 'macros',
      scope: ['entity.name.function.preprocessor', 'meta.preprocessor'],
      settings: { foreground: t('macro', base.keyword) },
    },
    {
      name: 'preprocessor',
      scope: ['meta.preprocessor'],
      settings: { foreground: t('preprocessor', t('label', base.number)) },
    },
    {
      name: 'urls',
      scope: ['markup.underline.link'],
      settings: { foreground: t('url', theme.colors.status.info) },
    },
    {
      name: 'tags',
      scope: ['entity.name.tag'],
      settings: { foreground: t('tag', base.keyword) },
    },
    {
      name: 'jsxTags',
      scope: ['support.class.component'],
      settings: { foreground: t('jsxTag', t('label', base.number)) },
    },
    {
      name: 'attributes',
      scope: ['entity.other.attribute-name', 'meta.attribute'],
      settings: { foreground: t('tagAttribute', base.type) },
    },
    {
      name: 'types',
      scope: ['support.type'],
      settings: { foreground: base.type },
    },
    {
      name: 'constants',
      scope: ['variable.other.constant', 'variable.readonly'],
      settings: { foreground: t('constant', base.foreground) },
    },
    {
      name: 'labels',
      scope: ['entity.name.label', 'punctuation.definition.label'],
      settings: { foreground: t('label', t('variableGlobal', base.number)) },
    },
    {
      name: 'namespaces',
      scope: ['entity.name.namespace', 'storage.modifier.namespace', 'markup.bold.markdown'],
      settings: { foreground: t('namespace', base.type) },
    },
    {
      name: 'modules',
      scope: ['entity.name.module', 'storage.modifier.module'],
      settings: { foreground: t('module', base.operator) },
    },
    {
      name: 'typeParameters',
      scope: ['variable.type.parameter', 'variable.parameter.type'],
      settings: { foreground: t('typeParameter', base.function) },
    },
    {
      name: 'exceptions',
      scope: ['keyword.control.exception', 'keyword.control.trycatch'],
      settings: { foreground: t('exception', t('label', base.number)) },
    },
    {
      name: 'decorators',
      scope: ['meta.decorator', 'punctuation.decorator', 'entity.name.function.decorator'],
      settings: { foreground: t('decorator', base.type) },
    },
    {
      name: 'calls',
      scope: ['variable.function'],
      settings: { foreground: base.foreground },
    },
    {
      name: 'punctuation',
      scope: [
        'punctuation',
        'punctuation.terminator',
        'punctuation.definition.tag',
        'punctuation.separator',
        'punctuation.definition.string',
        'punctuation.section.block',
      ],
      settings: { foreground: t('punctuation', base.comment) },
    },
    {
      name: 'yellow',
      scope: [
        'storage.type.numeric.go',
        'storage.type.byte.go',
        'storage.type.boolean.go',
        'storage.type.string.go',
        'storage.type.uintptr.go',
        'storage.type.error.go',
        'storage.type.rune.go',
        'constant.language.go',
        'support.class.dart',
        'keyword.other.documentation',
        'storage.modifier.import.java',
        'punctuation.definition.list.begin.markdown',
        'punctuation.definition.quote.begin.markdown',
        'meta.separator.markdown',
        'entity.name.section.markdown',
      ],
      settings: { foreground: base.type },
    },
    {
      name: 'green',
      scope: [],
      settings: { foreground: t('method', theme.colors.status.success) },
    },
    {
      name: 'cyan',
      scope: [
        'markup.italic.markdown',
        'support.type.python',
        'variable.legacy.builtin.python',
        'support.constant.property-value.css',
        'storage.modifier.attribute.swift',
      ],
      settings: { foreground: base.string },
    },
    {
      name: 'blue',
      scope: [],
      settings: { foreground: base.keyword },
    },
    {
      name: 'purple',
      scope: ['keyword.channel.go', 'keyword.other.platform.os.swift'],
      settings: { foreground: base.number },
    },
    {
      name: 'magenta',
      scope: ['punctuation.definition.heading.markdown'],
      settings: { foreground: t('label', t('variableGlobal', base.number)) },
    },
    {
      name: 'red',
      scope: [],
      settings: { foreground: base.operator },
    },
    {
      name: 'orange',
      scope: [],
      settings: { foreground: base.function },
    },
  ];
};

const buildColors = (theme: Theme): Record<string, string> => {
  const s = theme.colors.surface;
  const i = theme.colors.interactive;
  const st = theme.colors.status;
  const base = theme.colors.syntax.base;
  const hl = theme.colors.syntax.highlights ?? {};

  const diffAddedBg = pick(hl.diffAddedBackground, st.successBackground);
  const diffRemovedBg = pick(hl.diffRemovedBackground, st.errorBackground);

  return {
    'editor.background': s.background,
    'editor.foreground': s.foreground,
    'editor.hoverHighlightBackground': pick(i.hover, s.subtle),
    'editor.lineHighlightBackground': s.muted,
    'editor.selectionBackground': i.selection,
    'editor.selectionHighlightBackground': i.selection,
    'editor.findMatchBackground': base.type,
    'editor.findMatchHighlightBackground': addAlpha(base.type, 'cc'),
    'editor.findRangeHighlightBackground': s.muted,
    'editor.inactiveSelectionBackground': s.elevated,
    'editor.lineHighlightBorder': s.elevated,
    'editor.rangeHighlightBackground': pick(i.active, i.borderHover),
    'notifications.background': s.elevated,
    'editorInlayHint.typeBackground': s.subtle,
    'editorInlayHint.typeForeground': s.foreground,
    'editorWhitespace.foreground': i.borderHover,
    'editorIndentGuide.background1': s.subtle,
    'editorHoverWidget.background': s.elevated,
    'editorLineNumber.activeForeground': pick(hl.lineNumberActive, s.foreground),
    'editorLineNumber.foreground': pick(hl.lineNumber, s.mutedForeground),
    'editorGutter.background': s.background,
    'editorGutter.modifiedBackground': st.info,
    'editorGutter.addedBackground': st.success,
    'editorGutter.deletedBackground': st.error,
    'editorBracketMatch.background': s.elevated,
    'editorBracketMatch.border': s.subtle,
    'editorError.foreground': st.error,
    'editorWarning.foreground': st.warning,
    'editorInfo.foreground': st.info,
    'diffEditor.insertedTextBackground': diffAddedBg,
    'diffEditor.removedTextBackground': diffRemovedBg,
    'editorGroupHeader.tabsBackground': s.background,
    'editorGroup.border': i.border,
    'tab.activeBackground': s.background,
    'tab.inactiveBackground': s.muted,
    'tab.inactiveForeground': s.mutedForeground,
    'tab.activeForeground': s.foreground,
    'tab.hoverBackground': s.subtle,
    'tab.unfocusedHoverBackground': s.subtle,
    'tab.border': i.border,
    'tab.activeModifiedBorder': base.type,
    'tab.inactiveModifiedBorder': st.info,
    'tab.unfocusedActiveModifiedBorder': base.type,
    'tab.unfocusedInactiveModifiedBorder': st.info,
    'editorWidget.background': s.muted,
    'editorWidget.border': i.border,
    'editorSuggestWidget.background': s.background,
    'editorSuggestWidget.border': i.border,
    'editorSuggestWidget.foreground': s.foreground,
    'editorSuggestWidget.highlightForeground': s.mutedForeground,
    'editorSuggestWidget.selectedBackground': s.subtle,
    'peekView.border': i.border,
    'peekViewEditor.background': s.background,
    'peekViewEditor.matchHighlightBackground': s.subtle,
    'peekViewResult.background': s.muted,
    'peekViewResult.fileForeground': s.foreground,
    'peekViewResult.lineForeground': s.mutedForeground,
    'peekViewResult.matchHighlightBackground': s.subtle,
    'peekViewResult.selectionBackground': s.elevated,
    'peekViewResult.selectionForeground': s.mutedForeground,
    'peekViewTitle.background': s.subtle,
    'peekViewTitleDescription.foreground': s.mutedForeground,
    'peekViewTitleLabel.foreground': s.foreground,
    'merge.currentHeaderBackground': st.success,
    'merge.currentContentBackground': pick(hl.diffAdded, st.success),
    'merge.incomingHeaderBackground': st.info,
    'merge.incomingContentBackground': pick(hl.diffModified, st.info),
    'merge.border': i.border,
    'merge.commonContentBackground': s.subtle,
    'merge.commonHeaderBackground': s.muted,
    'panel.background': s.background,
    'panel.border': i.border,
    'panelTitle.activeBorder': i.borderHover,
    'panelTitle.activeForeground': s.foreground,
    'panelTitle.inactiveForeground': s.mutedForeground,
    'statusBar.background': s.background,
    'statusBar.foreground': s.foreground,
    'statusBar.border': i.border,
    'statusBar.debuggingBackground': st.error,
    'statusBar.debuggingForeground': st.errorForeground,
    'statusBar.noFolderBackground': s.subtle,
    'statusBar.noFolderForeground': s.mutedForeground,
    'titleBar.activeBackground': s.background,
    'titleBar.activeForeground': s.foreground,
    'titleBar.inactiveBackground': s.muted,
    'titleBar.inactiveForeground': s.mutedForeground,
    'titleBar.border': i.border,
    'menu.foreground': s.foreground,
    'menu.background': s.background,
    'menu.selectionForeground': s.foreground,
    'menu.selectionBackground': s.subtle,
    'menu.border': i.border,
    'editorInlayHint.foreground': s.mutedForeground,
    'editorInlayHint.background': s.subtle,
    'terminal.foreground': s.foreground,
    'terminal.background': s.background,
    'terminalCursor.foreground': s.foreground,
    'terminalCursor.background': s.background,
    'terminal.ansiRed': pick(hl.diffRemoved, st.error),
    'terminal.ansiGreen': pick(hl.diffAdded, st.success),
    'terminal.ansiYellow': st.warning,
    'terminal.ansiBlue': pick(hl.diffModified, st.info),
    'terminal.ansiMagenta': base.keyword,
    'terminal.ansiCyan': base.type,
    'activityBar.background': s.background,
    'activityBar.foreground': s.foreground,
    'activityBar.inactiveForeground': s.mutedForeground,
    'activityBar.activeBorder': s.foreground,
    'activityBar.border': i.border,
    'sideBar.background': s.background,
    'sideBar.foreground': s.foreground,
    'sideBar.border': i.border,
    'sideBarTitle.foreground': s.foreground,
    'sideBarSectionHeader.background': s.muted,
    'sideBarSectionHeader.foreground': s.foreground,
    'sideBarSectionHeader.border': i.border,
    'sideBar.activeBackground': s.subtle,
    'sideBar.activeForeground': s.foreground,
    'sideBar.hoverBackground': s.muted,
    'sideBar.hoverForeground': s.foreground,
    'list.warningForeground': st.warning,
    'list.errorForeground': st.error,
    'list.inactiveSelectionBackground': s.subtle,
    'list.activeSelectionBackground': s.elevated,
    'list.inactiveSelectionForeground': s.foreground,
    'list.activeSelectionForeground': s.foreground,
    'list.hoverForeground': s.foreground,
    'list.hoverBackground': s.muted,
    'input.background': s.muted,
    'input.foreground': s.foreground,
    'input.border': i.border,
    'input.placeholderForeground': s.mutedForeground,
    'inputOption.activeBorder': i.border,
    'inputOption.activeBackground': s.elevated,
    'inputOption.activeForeground': s.foreground,
    'inputValidation.infoBackground': st.infoBackground,
    'inputValidation.infoBorder': st.infoBorder,
    'inputValidation.warningBackground': st.warningBackground,
    'inputValidation.warningBorder': st.warningBorder,
    'inputValidation.errorBackground': st.errorBackground,
    'inputValidation.errorBorder': st.errorBorder,
    'dropdown.background': s.muted,
    'dropdown.foreground': s.foreground,
    'dropdown.border': i.border,
    'dropdown.listBackground': s.background,
    'badge.background': theme.colors.primary.base,
    'activityBarBadge.background': theme.colors.primary.base,
    'button.background': theme.colors.primary.base,
    'button.foreground': pick(theme.colors.primary.foreground, s.background),
    'badge.foreground': pick(theme.colors.primary.foreground, s.background),
    'activityBarBadge.foreground': pick(theme.colors.primary.foreground, s.background),
  };
};

export function buildTextMateThemeFromAppTheme(theme: Theme): VSCodeTextMateTheme {
  return {
    name: theme.metadata.name,
    type: theme.metadata.variant,
    colors: buildColors(theme),
    tokenColors: buildTokenColors(theme),
  };
}
