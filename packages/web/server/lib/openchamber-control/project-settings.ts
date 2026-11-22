// The project settings the control service edits. A fork module.
import { z } from 'zod';
import type { JsonValue } from '../shared/json-values.js';

/** A configured project as `sanitizeProjects` keeps it: identity plus the per-project settings. */
export interface ControlProject { id: string; path: string; label?: string; [setting: string]: JsonValue | undefined }

/** A project's editable settings, as Project settings shows them. */
export type ProjectSettings = Partial<Record<string, JsonValue>>;

export interface UpdatedProject {
  project: { id: string; path: string; settings: ProjectSettings };
  note: string;
  alsoCleared?: string[];
}

// The tool input is JSON, so a projectSettings object holds only JSON values.
export const projectSettingsSchema = z.record(z.string(), z.json());
