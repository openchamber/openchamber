import { existsSync } from 'node:fs';

const sourceLoader = new URL('../../../scripts/register-server-sources.mjs', import.meta.url);
if (!process.versions.bun && existsSync(sourceLoader)) await import(sourceLoader.href);

await import('./repository-credential-helper-runtime.js');
