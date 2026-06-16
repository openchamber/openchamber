import { readAuthFile } from '../../opencode/auth.js';
import { getAuthEntry, normalizeAuthEntry } from './auth.js';
import { isJsonMode, isQuietMode, printJson, log } from '../../../../bin/cli-output.js';

export const loginWithAuthCheck = async ({ options, id, name, aliases }) => {
  const auth = readAuthFile();
  const entry = normalizeAuthEntry(getAuthEntry(auth, aliases));
  if (entry?.key || entry?.token || entry?.access) return;
  if (isJsonMode(options)) printJson({ provider: id, command: 'opencode auth login' });
  else if (isQuietMode(options)) process.stdout.write('Run: opencode auth login\n');
  else log.info(`Run 'opencode auth login' to add auth for ${name}.`);
};
