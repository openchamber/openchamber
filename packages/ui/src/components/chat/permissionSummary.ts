import { z } from 'zod';
import type { I18nKey } from '@/lib/i18n';

export type PermissionTarget = {
  value: string;
  isPath: boolean;
  file?: string;
};

type PermissionSummary = {
  titleKey: I18nKey;
  tool?: string;
  targets: PermissionTarget[];
  scope?: string;
  metadataExplained: boolean;
};

const optionalText = z.string().min(1).optional().catch(undefined);

export const permissionSummaryMetadataSchema = z.object({
  filepath: optionalText,
  parentDir: optionalText,
  path: optionalText,
}).catch({});

type PermissionSummaryMetadata = z.infer<typeof permissionSummaryMetadataSchema>;

const DIRECTORY_GLOB = /\/\*$/;

const stripDirectoryGlob = (pattern: string): string => (DIRECTORY_GLOB.test(pattern) && pattern !== '/*' ? pattern.replace(DIRECTORY_GLOB, '') : pattern);

const fileName = (filePath: string): string => filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;

const textTargets = (resources: readonly string[], isPath: boolean): PermissionTarget[] =>
  resources.filter((value) => value && value !== '*').map((value) => ({ value, isPath }));

export const summarizePermission = (
  action: string,
  resources: readonly string[],
  metadata: PermissionSummaryMetadata,
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

export const canSavePermission = (save: readonly string[] | undefined): boolean => (save?.length ?? 0) > 0;

export const describeSavePatterns = (action: string, save: readonly string[]): string[] => {
  if (save.length === 0 || save.every((pattern) => pattern === '*')) return [];
  return action.toLowerCase() === 'external_directory' ? save.map(stripDirectoryGlob) : [...save];
};
