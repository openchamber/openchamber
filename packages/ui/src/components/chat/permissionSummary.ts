import { z } from 'zod';
import type { I18nKey } from '@/lib/i18n';

/**
 * What a permission request asks for, in the user's terms. OpenCode names the
 * capability (`action`) and the things it applies to (`resources`); for
 * directory access the resources are globs such as `/abs/dir/*`, so the card
 * shows the directory itself instead of the glob.
 */
export type PermissionTarget = {
  /** Path, pattern, query, or id the request applies to. */
  value: string;
  /** Whether `value` is a filesystem path that can be shortened to `~`. */
  isPath: boolean;
  /** A file inside `value` that triggered a directory request. */
  file?: string;
};

export type PermissionSummary = {
  titleKey: I18nKey;
  /** Only set for `chat.permissionCard.summary.tool`. */
  tool?: string;
  targets: PermissionTarget[];
  /** Search scope for glob/grep requests. */
  scope?: string;
  /** Metadata fully explained by the summary; the raw fallback stays hidden. */
  metadataExplained: boolean;
};

const optionalText = z.string().min(1).optional().catch(undefined);

/**
 * Metadata fields the summary explains. `filepath`/`parentDir` come with an
 * external-directory request raised by a patch; `path` is a glob/grep scope.
 */
export const permissionSummaryMetadataSchema = z.object({
  filepath: optionalText,
  parentDir: optionalText,
  path: optionalText,
}).catch({});

export type PermissionSummaryMetadata = z.infer<typeof permissionSummaryMetadataSchema>;

const DIRECTORY_GLOB = /\/\*$/;

/** `/abs/dir/*` → `/abs/dir`; anything else is returned unchanged. */
export const stripDirectoryGlob = (pattern: string): string => (DIRECTORY_GLOB.test(pattern) && pattern !== '/*' ? pattern.replace(DIRECTORY_GLOB, '') : pattern);

const fileName = (filePath: string): string => filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;

const textTargets = (resources: readonly string[], isPath: boolean): PermissionTarget[] =>
  resources.filter((value) => value && value !== '*').map((value) => ({ value, isPath }));

export const summarizePermission = (
  action: string,
  resources: readonly string[],
  metadata: PermissionSummaryMetadata,
  /** The request carries metadata beyond what this summary can explain. */
  hasMetadata: boolean,
): PermissionSummary => {
  const tool = action.toLowerCase();

  switch (tool) {
    case 'external_directory': {
      const { filepath, parentDir } = metadata;
      const targets = resources.map((resource): PermissionTarget => {
        const target: PermissionTarget = { value: stripDirectoryGlob(resource), isPath: true };
        if (filepath && (parentDir ? stripDirectoryGlob(parentDir) === target.value : filepath.startsWith(`${target.value}/`))) {
          target.file = fileName(filepath);
        }
        return target;
      });
      return { titleKey: 'chat.permissionCard.summary.externalDirectory', targets, metadataExplained: true };
    }
    case 'read':
      return { titleKey: 'chat.permissionCard.summary.read', targets: textTargets(resources, true), metadataExplained: true };
    case 'edit':
    case 'write':
    case 'patch':
      return { titleKey: 'chat.permissionCard.summary.edit', targets: textTargets(resources, true), metadataExplained: true };
    case 'shell':
    case 'bash':
    case 'shell_command':
      return { titleKey: 'chat.permissionCard.summary.shell', targets: [], metadataExplained: true };
    case 'glob':
    case 'grep': {
      const summary: PermissionSummary = {
        titleKey: tool === 'glob' ? 'chat.permissionCard.summary.glob' : 'chat.permissionCard.summary.grep',
        targets: textTargets(resources, false),
        metadataExplained: true,
      };
      if (metadata.path && metadata.path !== '.') summary.scope = metadata.path;
      return summary;
    }
    case 'webfetch':
      return { titleKey: 'chat.permissionCard.summary.webfetch', targets: [], metadataExplained: true };
    case 'websearch':
      return { titleKey: 'chat.permissionCard.summary.websearch', targets: textTargets(resources, false), metadataExplained: true };
    case 'skill':
      return { titleKey: 'chat.permissionCard.summary.skill', targets: textTargets(resources, false), metadataExplained: true };
    default:
      return {
        titleKey: 'chat.permissionCard.summary.tool',
        tool: action,
        targets: textTargets(resources, false),
        metadataExplained: !hasMetadata,
      };
  }
};

/**
 * Patterns an "always" reply saves, as the user reads them. A lone `*` means
 * the whole capability, which the plain "Always allow" label already says.
 */
export const describeSavePatterns = (action: string, save: readonly string[]): string[] => {
  if (save.length === 0 || save.every((pattern) => pattern === '*')) return [];
  return action.toLowerCase() === 'external_directory' ? save.map(stripDirectoryGlob) : [...save];
};
