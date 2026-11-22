// The size cap on OpenCode config files, for reads and writes alike. A fork
// module: upstream reads config files whole.
import { readBoundedFileSync } from '../shared/bounded-file-read.js';

export const CONFIG_FILE_TOO_LARGE = 'CONFIG_FILE_TOO_LARGE';

// Config files are hand-written JSONC; the precedent caps in this server run
// 1-4 MiB (AGENTS.md 1 MiB, SKILL.md 4 MiB). 4 MiB is generous for a config
// while keeping a cloned project's oversized opencode.json(c) from being
// buffered whole, synchronously, on every settings/plugin/MCP read.
export const MAX_CONFIG_FILE_BYTES = 4 * 1024 * 1024;

export function isConfigFileTooLargeError(error: unknown): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && error.code === CONFIG_FILE_TOO_LARGE;
}

// Open once and judge from the handle (design #1254): a
// stat-by-path-then-readFile-by-path gate lets a config grown or swapped
// after the stat buffer whole past the cap. The shared bounded read fixes
// the file identity at open, judges the size from the handle, and reads at
// most one byte over the cap, so growth is refused, never buffered. Its
// missing and non-regular answers are mapped back onto this module's
// existing contract: a file that vanishes after the exists check throws the
// ENOENT a stat would have thrown, and a non-regular file throws the EISDIR
// a read would have thrown.
export function readCappedConfigFileSync(filePath: string) {
  const result = readBoundedFileSync(filePath, MAX_CONFIG_FILE_BYTES);
  if (result.ok) {
    return result.buffer.toString('utf8');
  }
  if (result.reason === 'too-large') {
    throw Object.assign(new Error(
      `OpenCode configuration at ${filePath} exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit and cannot be loaded safely`,
    ), { code: CONFIG_FILE_TOO_LARGE });
  }
  if (result.reason === 'missing') {
    throw Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), { code: 'ENOENT' });
  }
  throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`), { code: 'EISDIR' });
}

// Enforce the cap on the serialized result too: writing a config that crosses
// the read cap would strand the layer — later reads omit it as
// CONFIG_FILE_TOO_LARGE and later writes refuse it, so the user could not undo
// the change through OpenChamber. Reject before replacing the file, preserving
// the readable original.
export function assertSerializedConfigWithinCap(filePath: string, content: string) {
  if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_FILE_BYTES) {
    throw Object.assign(new Error(
      `Serialized OpenCode configuration for ${filePath} exceeds the ${MAX_CONFIG_FILE_BYTES}-byte limit and cannot be written safely`,
    ), { code: CONFIG_FILE_TOO_LARGE });
  }
}
