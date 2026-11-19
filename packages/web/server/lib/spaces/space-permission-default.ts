
import { z } from 'zod';

import { PERMISSION_MODES, isPermissionMode } from '../permission-auto-accept/modes.js';
import type { PermissionMode } from '../permission-auto-accept/modes.js';
import { readSpaceSettingFile } from './space-setting-file.js';

const permissionDefaultSchema = z.object({ mode: z.enum(PERMISSION_MODES) }).strict();

export const permissionDefaultOf = (value: PermissionMode | null | undefined) => ({ mode: isPermissionMode(value) ? value : 'ask' });

export const readSpacePermissionDefault = async (filePath: string) => (await readSpaceSettingFile(filePath, permissionDefaultSchema))?.mode ?? null;
