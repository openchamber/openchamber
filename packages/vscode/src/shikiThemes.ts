import * as vscode from 'vscode';

type VSCodeThemeContribution = {
  label?: string;
  uiTheme?: string;
  path?: string;
};

export type WebviewShikiThemePayload = {
  light?: Record<string, unknown>;
  dark?: Record<string, unknown>;
};

const stripJsonc = (input: string): string => {
  let output = '';
  let inString = false;
  let stringQuote: '"' | '\'' | null = null;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        output += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i++;
      }
      continue;
    }

    if (inString) {
      output += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (stringQuote && ch === stringQuote) {
        inString = false;
        stringQuote = null;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      inLineComment = true;
      i++;
      continue;
    }

    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    if (ch === '"' || ch === '\'') {
      inString = true;
      stringQuote = ch;
      output += ch;
      continue;
    }

    output += ch;
  }

  return output;
};

const stripTrailingCommas = (input: string): string => {
  let output = '';
  let inString = false;
  let stringQuote: '"' | '\'' | null = null;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      output += ch;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (stringQuote && ch === stringQuote) {
        inString = false;
        stringQuote = null;
      }
      continue;
    }

    if (ch === '"' || ch === '\'') {
      inString = true;
      stringQuote = ch;
      output += ch;
      continue;
    }

    if (ch === ',') {
      // If the next non-whitespace character is a closing brace/bracket, drop this comma.
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j] ?? '')) j++;
      const nextNonWs = input[j];
      if (nextNonWs === '}' || nextNonWs === ']') {
        continue;
      }
    }

    output += ch;
  }

  return output;
};

const parseJsoncLoose = (input: string): Record<string, unknown> | null => {
  try {
    const noComments = stripJsonc(input);
    const noTrailingCommas = stripTrailingCommas(noComments);
    const parsed = JSON.parse(noTrailingCommas) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

const getThemeLabelFromConfig = (key: string): string | undefined => {
  return vscode.workspace.getConfiguration('workbench').get<string>(key) || undefined;
};

const normalizeLabel = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();

const labelVariants = (label: string): string[] => {
  const trimmed = label.trim();
  const variants = new Set<string>([trimmed]);

  // VS Code sometimes uses "Default …" in settings while theme contributions omit it.
  if (trimmed.toLowerCase().startsWith('default ')) {
    variants.add(trimmed.slice('default '.length));
  }

  return Array.from(variants);
};

const findContributedTheme = (label: string): { extension: vscode.Extension<unknown>; theme: VSCodeThemeContribution } | null => {
  const targets = labelVariants(label).map(normalizeLabel);
  for (const extension of vscode.extensions.all) {
    const contributes = (extension.packageJSON as { contributes?: { themes?: VSCodeThemeContribution[] } } | undefined)?.contributes;
    const themes = contributes?.themes;
    if (!Array.isArray(themes)) continue;

    const match = themes.find((theme) => theme?.label && targets.includes(normalizeLabel(theme.label)));
    if (match?.path) {
      return { extension, theme: match };
    }
  }
  return null;
};

const readThemeJsonByLabel = async (label: string): Promise<Record<string, unknown> | null> => {
  const resolved = findContributedTheme(label);
  if (!resolved) return null;

  try {
    const uri = vscode.Uri.joinPath(resolved.extension.extensionUri, resolved.theme.path as string);
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = new TextDecoder('utf-8').decode(bytes);
    return parseJsoncLoose(text);
  } catch {
    return null;
  }
};

const ensureUniqueThemeName = (raw: Record<string, unknown>, suffix: string): Record<string, unknown> => {
  const originalName = typeof raw.name === 'string' && raw.name.length > 0 ? raw.name : 'VSCode Theme';
  return { ...raw, name: `${originalName} (${suffix})` };
};

export async function getWebviewShikiThemes(): Promise<WebviewShikiThemePayload | null> {
  const current = getThemeLabelFromConfig('colorTheme');
  const preferredLight = getThemeLabelFromConfig('preferredLightColorTheme') || current;
  const preferredDark = getThemeLabelFromConfig('preferredDarkColorTheme') || current;

  const themeVariant =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Light ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrastLight
      ? 'light'
      : 'dark';

  // Use the actively selected theme for the current variant, and only fall back to preferred
  // themes for the opposite variant (so we actually pick up user-selected theme changes).
  const lightLabel = themeVariant === 'light' ? current : preferredLight;
  const darkLabel = themeVariant === 'dark' ? current : preferredDark;

  const [lightRaw, darkRaw] = await Promise.all([
    lightLabel ? readThemeJsonByLabel(lightLabel) : Promise.resolve(null),
    darkLabel ? readThemeJsonByLabel(darkLabel) : Promise.resolve(null),
  ]);

  // If we only managed to resolve one side, use it for both. This still gives correct highlighting
  // for the currently active VS Code theme, and avoids falling back to Flexoki.
  const fallbackOneSide = lightRaw ?? darkRaw;
  const effectiveLight = lightRaw ?? fallbackOneSide;
  const effectiveDark = darkRaw ?? fallbackOneSide;

  return !effectiveLight && !effectiveDark
    ? null
    : {
        light: effectiveLight ? ensureUniqueThemeName(effectiveLight, 'Light') : undefined,
        dark: effectiveDark ? ensureUniqueThemeName(effectiveDark, 'Dark') : undefined,
      };
}
