import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type fs from 'node:fs/promises';
import type nodePath from 'node:path';
import type { JsonValue } from '../shared/json-values.js';
import type { Request } from '../shared/http-contracts.js';
import { isString } from '../shared/object-guards.js';

export interface ThemeRuntimeDependencies {
  fsPromises: Pick<typeof fs, 'stat' | 'lstat' | 'readFile' | 'readdir' | 'mkdir' | 'writeFile' | 'link' | 'unlink'>;
  path: Pick<typeof nodePath, 'join'>;
  themesDir: string;
  maxThemeJsonBytes: number;
  logger: Pick<Console, 'warn'>;
}

export interface NormalizedTheme {
  colors?: unknown;
  metadata: {
    id: string;
    name: string;
    description: string;
    version: string;
    variant: 'light' | 'dark';
    tags: string[];
  };
}

interface ThemeFileInput {
  metadata?: unknown;
  colors?: unknown;
}

interface ThemeMetadataInput {
  id?: unknown;
  name?: unknown;
  variant?: unknown;
  tags?: unknown;
  description?: unknown;
  version?: unknown;
}

interface ThemeColorsInput {
  primary?: unknown;
  surface?: unknown;
  interactive?: unknown;
  status?: unknown;
  syntax?: unknown;
}

interface ThemeColorRoles {
  base?: unknown;
  background?: unknown;
  foreground?: unknown;
  muted?: unknown;
  mutedForeground?: unknown;
  elevated?: unknown;
  border?: unknown;
  error?: unknown;
  warning?: unknown;
  success?: unknown;
  info?: unknown;
  keyword?: unknown;
  string?: unknown;
  number?: unknown;
  function?: unknown;
  variable?: unknown;
  type?: unknown;
  comment?: unknown;
  operator?: unknown;
}

const isThemeFileInput = (value: unknown): value is ThemeFileInput & object => Boolean(value) && typeof value === 'object';
const isThemeMetadataInput = (value: unknown): value is ThemeMetadataInput => Boolean(value) && typeof value === 'object';
const isThemeColorsInput = (value: unknown): value is ThemeColorsInput => Boolean(value) && typeof value === 'object';
const isThemeSyntaxInput = (value: unknown): value is Pick<ThemeColorRoles, 'base'> => Boolean(value) && typeof value === 'object';
const hasThemeColorRoles = (value: unknown): value is ThemeColorRoles => Boolean(value);
const hasFileErrorCode = (value: unknown): value is { code?: unknown } => Boolean(value) && typeof value === 'object';

const color = z.string().regex(/^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i);
const role = z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/).max(64);
const importedThemeSchema = z.object({
  metadata: z.object({
    name: z.string().trim().min(1).max(160),
    author: z.string().max(160).optional(),
    variant: z.enum(['light', 'dark']),
    description: z.string().max(1024).default(''),
    version: z.string().max(40).default('1.0.0'),
    tags: z.array(z.string().max(40)).max(16).default([]),
  }),
  colors: z.record(role, z.record(role, z.union([color, z.record(role, color)]))),
});
const fileErrorSchema = z.object({ code: z.string() });

export class ThemeImportStorageError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export const createThemeRuntime = (dependencies: ThemeRuntimeDependencies) => {
  const {
    fsPromises,
    path,
    themesDir,
    maxThemeJsonBytes,
    logger,
  } = dependencies;

  const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
  const isValidThemeColor = isNonEmptyString;

  const normalizeThemeJson = (raw: JsonValue): NormalizedTheme | null => {
    if (!isThemeFileInput(raw)) {
      return null;
    }

    const metadata = isThemeMetadataInput(raw.metadata) ? raw.metadata : null;
    const colors = isThemeColorsInput(raw.colors) ? raw.colors : null;
    if (!metadata || !colors) {
      return null;
    }

    const id = metadata.id;
    const name = metadata.name;
    const variant = metadata.variant;
    if (!isNonEmptyString(id) || !isNonEmptyString(name) || (variant !== 'light' && variant !== 'dark')) {
      return null;
    }

    const primary = colors.primary;
    const surface = colors.surface;
    const interactive = colors.interactive;
    const status = colors.status;
    const syntax = colors.syntax;
    const syntaxBase = isThemeSyntaxInput(syntax) ? syntax.base : null;

    if (!hasThemeColorRoles(primary) || !hasThemeColorRoles(surface) || !hasThemeColorRoles(interactive) || !hasThemeColorRoles(status) || !hasThemeColorRoles(syntaxBase)) {
      return null;
    }

    const required = [
      primary.base,
      surface.background,
      surface.foreground,
      surface.muted,
      surface.mutedForeground,
      surface.elevated,
      interactive.border,
      status.error,
      status.warning,
      status.success,
      status.info,
      syntaxBase.keyword,
      syntaxBase.string,
      syntaxBase.number,
      syntaxBase.function,
      syntaxBase.variable,
      syntaxBase.type,
      syntaxBase.comment,
      syntaxBase.operator,
    ];

    if (!required.every(isValidThemeColor)) {
      return null;
    }

    const tags = Array.isArray(metadata.tags)
      ? metadata.tags.filter(isNonEmptyString)
      : [];

    return {
      ...raw,
      metadata: {
        ...metadata,
        id: id.trim(),
        name: name.trim(),
        description: isString(metadata.description) ? metadata.description : '',
        version: isString(metadata.version) && metadata.version.trim().length > 0 ? metadata.version : '1.0.0',
        variant,
        tags,
      },
    };
  };

  const lastValidThemes = new Map<string, NormalizedTheme>();

  const readThemeFile = async (name: string) => {
    const filePath = path.join(themesDir, name);
    try {
      const stat = await fsPromises.stat(filePath);
      if (!stat.isFile()) return undefined;
      if (stat.size > maxThemeJsonBytes) {
        logger.warn(`[themes] ${name} is too large (${stat.size} bytes)`);
        return null;
      }
      const normalized = normalizeThemeJson(JSON.parse(await fsPromises.readFile(filePath, 'utf8')));
      if (!normalized) logger.warn(`[themes] ${name} is not a valid theme`);
      return normalized;
    } catch (error) {
      logger.warn(`[themes] Failed to read ${name}:`, error);
      return null;
    }
  };

  const readCustomThemesFromDisk = async () => {
    try {
      const entries = await fsPromises.readdir(themesDir, { withFileTypes: true });
      const themes: NormalizedTheme[] = [];
      const seen = new Set<string>();
      const listed = new Set<string>();

      for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!entry.name.toLowerCase().endsWith('.json')) continue;

        const loaded = await readThemeFile(entry.name);
        if (loaded === undefined) continue;
        listed.add(entry.name);
        if (loaded) lastValidThemes.set(entry.name, loaded);
        const theme = loaded ?? lastValidThemes.get(entry.name);
        if (!theme) continue;
        if (!loaded) logger.warn(`[themes] Keeping the last valid version of ${entry.name}`);

        const id = theme.metadata.id;
        if (seen.has(id)) {
          logger.warn(`[themes] Skip ${entry.name}: duplicate theme id "${id}"`);
          continue;
        }

        seen.add(id);
        themes.push(theme);
      }

      for (const name of lastValidThemes.keys()) {
        if (!listed.has(name)) lastValidThemes.delete(name);
      }

      return themes;
    } catch (error) {
      if (hasFileErrorCode(error) && error.code === 'ENOENT') {
        lastValidThemes.clear();
        return [];
      }
      logger.warn('[themes] Failed to list custom themes dir:', error);
      throw error;
    }
  };

  const saveImportedTheme = async (raw: Request['body']) => {
    const parsed = importedThemeSchema.safeParse(raw);
    if (!parsed.success) throw new ThemeImportStorageError('invalid', 400);
    const normalized = normalizeThemeJson({ ...parsed.data, metadata: { ...parsed.data.metadata, id: 'import' } });
    if (!normalized) throw new ThemeImportStorageError('invalid', 400);
    const digest = createHash('sha256').update(JSON.stringify(parsed.data)).digest('hex').slice(0, 24);
    const theme = { ...normalized, metadata: { ...normalized.metadata, id: `imported-vscode-${digest}` } };
    const contents = `${JSON.stringify(theme, null, 2)}\n`;
    if (Buffer.byteLength(contents, 'utf8') > maxThemeJsonBytes) throw new ThemeImportStorageError('size', 413);
    await fsPromises.mkdir(themesDir, { recursive: true });
    const target = path.join(themesDir, `${theme.metadata.id}.json`);
    const temporary = path.join(themesDir, `${randomUUID()}.tmp`);
    try {
      await fsPromises.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
      try {
        await fsPromises.link(temporary, target);
      } catch (error) {
        const parsedError = fileErrorSchema.safeParse(error);
        if (!parsedError.success || parsedError.data.code !== 'EEXIST') throw error;
        if (await fsPromises.readFile(target, 'utf8') !== contents) throw new ThemeImportStorageError('conflict', 409);
      }
      return theme;
    } finally {
      await fsPromises.unlink(temporary).catch((error) => {
        const parsedError = fileErrorSchema.safeParse(error);
        if (!parsedError.success || parsedError.data.code !== 'ENOENT') logger.warn('[themes] Failed to clean import temporary file');
      });
    }
  };

  return {
    normalizeThemeJson,
    readCustomThemesFromDisk,
    saveImportedTheme,
    async deleteImportedTheme(id: string | undefined) {
      if (!z.string().trim().min(1).max(256).safeParse(id).success) throw new ThemeImportStorageError('invalid', 400);
      const matches: string[] = [];
      let readFailure;
      let entries;
      try { entries = await fsPromises.readdir(themesDir, { withFileTypes: true }); }
      catch (error) {
        if (fileErrorSchema.safeParse(error).data?.code === 'ENOENT') return;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const target = path.join(themesDir, entry.name);
        let text;
        try {
          const stat = await fsPromises.lstat(target);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxThemeJsonBytes) continue;
          text = await fsPromises.readFile(target, 'utf8');
        } catch (error) {
          if (fileErrorSchema.safeParse(error).data?.code !== 'ENOENT') readFailure = error;
          continue;
        }
        let theme;
        try { theme = normalizeThemeJson(JSON.parse(text)); }
        catch { theme = null; }
        theme ??= lastValidThemes.get(entry.name);
        if (theme?.metadata.id === id) matches.push(target);
      }
      if (matches.length > 1) throw new ThemeImportStorageError('conflict', 409);
      const [match] = matches;
      if (match === undefined) {
        if (readFailure) throw readFailure;
        return;
      }
      await fsPromises.unlink(match);
    },
  };
};
