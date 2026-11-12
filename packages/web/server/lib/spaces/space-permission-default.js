// The permission mode a new chat starts in, Settings → Sessions, for the chats of a space. The
// server inside a space keeps the modes of its chats, see `../permission-auto-accept/`, and has no
// Settings of its own, so the host writes the user's choice into a file in the space's HOME at
// every start and whenever the user changes it, and the server inside reads that file when a chat
// is created. Changing it never reaches back into older chats, as on the host.
//
// The agent can rewrite the file. That gives it nothing: it runs as the same user as the server
// inside, which owns the server's settings and its token, so the agent can set any chat's mode
// with or without this file. The mode protects the user from what the agent does inside the
// container; it never protected anything from the agent.
//
// This module runs on both sides: the host shapes the setting, and the server inside reads it,
// only when the space's environment names the file.

import { z } from 'zod';

import { PERMISSION_MODES, isPermissionMode } from '../permission-auto-accept/modes.js';
import { readSpaceSettingFile } from './space-setting-file.js';

const permissionDefaultSchema = z.object({ mode: z.enum(PERMISSION_MODES) }).strict();

/** The setting as the host writes it, from the value in `settings.json`: `ask` when it is missing or not a mode. */
export const permissionDefaultOf = (value) => ({ mode: isPermissionMode(value) ? value : 'ask' });

/** The mode the host wrote, or null when the file is missing or unreadable, which writes no mode. */
export const readSpacePermissionDefault = async (filePath) => (await readSpaceSettingFile(filePath, permissionDefaultSchema))?.mode ?? null;
