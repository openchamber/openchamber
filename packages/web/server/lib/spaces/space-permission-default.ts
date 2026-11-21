
import { z } from 'zod';

import { PERMISSION_MODES, isPermissionMode } from '../permission-auto-accept/modes.js';
import { readSpaceSettingFile } from './space-setting-file.js';
import type { SettingsDocument } from '../settings/settings-helpers.js';

const permissionDefaultSchema = z.object({ mode: z.enum(PERMISSION_MODES) }).strict();

export const permissionDefaultOf = (value: SettingsDocument[string]) => ({ mode: isPermissionMode(value) ? value : 'ask' });

export const readSpacePermissionDefault = async (filePath: string) => (await readSpaceSettingFile(filePath, permissionDefaultSchema))?.mode ?? null;
