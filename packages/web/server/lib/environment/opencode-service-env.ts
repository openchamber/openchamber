import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import { isVariableName } from './variables.js';

const serviceFileSchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
});

export const readOpenCodeServiceEnv = (configDir: string) => {
  let raw;
  try {
    raw = fs.readFileSync(path.join(configDir, 'service.json'), 'utf8');
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = serviceFileSchema.safeParse(JSON.parse(raw));
  } catch {
    return {};
  }
  if (!parsed.success) return {};
  return Object.fromEntries(Object.entries(parsed.data.env ?? {}).filter(([name]) => isVariableName(name)));
};
