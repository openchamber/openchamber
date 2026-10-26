import * as vscode from 'vscode';

export type ThemeKindName = 'light' | 'dark';

export function getThemeKindName(kind: vscode.ColorThemeKind): ThemeKindName {
  switch (kind) {
    case vscode.ColorThemeKind.Light:
    case vscode.ColorThemeKind.HighContrastLight:
      return 'light';
    case vscode.ColorThemeKind.Dark:
    case vscode.ColorThemeKind.HighContrast:
    default:
      return 'dark';
  }
}
