import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

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
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export const createThemeRuntime = (dependencies) => {
  const {
    fsPromises,
    path,
    themesDir,
    maxThemeJsonBytes,
    logger,
  } = dependencies;

  const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;
  const isValidThemeColor = (value) => isNonEmptyString(value);

  const normalizeThemeJson = (raw) => {
    if (!raw || typeof raw !== 'object') {
      return null;
    }

    const metadata = raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : null;
    const colors = raw.colors && typeof raw.colors === 'object' ? raw.colors : null;
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
    const syntaxBase = syntax && typeof syntax === 'object' ? syntax.base : null;

    if (!primary || !surface || !interactive || !status || !syntaxBase) {
      return null;
    }

    // Authored inputs only. The UI resolves optional roles before rendering.
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
      ? metadata.tags.filter((tag) => typeof tag === 'string' && tag.trim().length > 0)
      : [];

    return {
      ...raw,
      metadata: {
        ...metadata,
        id: id.trim(),
        name: name.trim(),
        description: typeof metadata.description === 'string' ? metadata.description : '',
        version: typeof metadata.version === 'string' && metadata.version.trim().length > 0 ? metadata.version : '1.0.0',
        variant,
        tags,
      },
    };
  };

  const readCustomThemesFromDisk = async () => {
    try {
      const entries = await fsPromises.readdir(themesDir, { withFileTypes: true });
      const themes = [];
      const seen = new Set();

      for (const entry of entries) {
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!entry.name.toLowerCase().endsWith('.json')) continue;

        const filePath = path.join(themesDir, entry.name);
        try {
          const stat = await fsPromises.stat(filePath);
          if (!stat.isFile()) continue;
          if (stat.size > maxThemeJsonBytes) {
            logger.warn(`[themes] Skip ${entry.name}: too large (${stat.size} bytes)`);
            continue;
          }

          const rawText = await fsPromises.readFile(filePath, 'utf8');
          const parsed = JSON.parse(rawText);
          const normalized = normalizeThemeJson(parsed);
          if (!normalized) {
            logger.warn(`[themes] Skip ${entry.name}: invalid theme JSON`);
            continue;
          }

          const id = normalized.metadata.id;
          if (seen.has(id)) {
            logger.warn(`[themes] Skip ${entry.name}: duplicate theme id "${id}"`);
            continue;
          }

          seen.add(id);
          themes.push(normalized);
        } catch (error) {
          logger.warn(`[themes] Failed to read ${entry.name}:`, error);
        }
      }

      return themes;
    } catch (error) {
      // Missing dir is fine.
      if (error && typeof error === 'object' && error.code === 'ENOENT') {
        return [];
      }
      logger.warn('[themes] Failed to list custom themes dir:', error);
      throw error;
    }
  };

  const saveImportedTheme = async (raw) => {
    const parsed = importedThemeSchema.safeParse(raw);
    if (!parsed.success) throw new ThemeImportStorageError('invalid', 400);
    const normalized = normalizeThemeJson({ ...parsed.data, metadata: { ...parsed.data.metadata, id: 'import' } });
    if (!normalized) throw new ThemeImportStorageError('invalid', 400);
    // The client supplies colors, never a filename or an overwrite target.
    // Identical imports have the same ID, including retries after a lost reply.
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
        // Link publishes the complete file atomically and cannot overwrite an
        // existing theme, even if another import finishes at the same time.
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
    async deleteImportedTheme(id) {
      if (!z.string().trim().min(1).max(256).safeParse(id).success) throw new ThemeImportStorageError('invalid', 400);
      const matches = [];
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
        catch { continue; }
        if (theme?.metadata.id === id) matches.push(target);
      }
      // IDs identify themes, not filenames. Refuse ambiguous matches rather
      // than deleting an arbitrary sibling or constructing a path from the ID.
      if (matches.length > 1) throw new ThemeImportStorageError('conflict', 409);
      if (!matches.length) {
        if (readFailure) throw readFailure;
        return;
      }
      await fsPromises.unlink(matches[0]);
    },
  };
};
