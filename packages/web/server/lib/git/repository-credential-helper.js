import { existsSync } from 'node:fs';

const sourceLoader = new URL('../../../scripts/register-server-sources.mjs', import.meta.url);
if (!process.versions.bun && existsSync(sourceLoader)) await import(sourceLoader.href);
// The delegate below asks the person's own credential chain, whose helpers
// can stall (a GUI prompt, a network store). Bound it in the same 10s class
// as the server request so a stalled chain cannot hang the Git operation
// that invoked this helper indefinitely (#867).
const DELEGATE_TIMEOUT_MS = 10_000;

await import('./repository-credential-helper-runtime.js');
