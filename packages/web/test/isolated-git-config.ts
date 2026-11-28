import { devNull } from 'node:os';

// Git still reads command-scoped overrides after global and system config are disabled.
for (const key of Object.keys(process.env)) {
  if (/^GIT_CONFIG(?:_|$)/i.test(key)) delete process.env[key];
}
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_NOSYSTEM = '1';
