import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateLocalPath, unsupportedAppSpecificOpenError } from '../path-open-utils.mjs';

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const expectRejects = async (label, callback, expected) => {
  try {
    await callback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    assert(message.includes(expected), `${label}: expected "${expected}" in "${message}"`);
    return message;
  }
  throw new Error(`${label}: expected rejection`);
};

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-path-open-'));
try {
  const existingFile = path.join(tempRoot, 'existing.txt');
  await fs.writeFile(existingFile, 'ok', 'utf8');

  const validated = await validateLocalPath(existingFile);
  assert(validated.path === existingFile, 'valid file path should resolve to the same absolute path');
  assert(validated.stats.isFile(), 'valid file path should return file stats');

  const validatedDirectory = await validateLocalPath(tempRoot, 'Directory');
  assert(validatedDirectory.path === tempRoot, 'valid directory path should resolve to the same absolute path');
  assert(validatedDirectory.stats.isDirectory(), 'valid directory path should return directory stats');

  const missingMessage = await expectRejects(
    'missing path',
    () => validateLocalPath(path.join(tempRoot, 'missing.txt')),
    'does not exist',
  );
  const emptyMessage = await expectRejects(
    'empty path',
    () => validateLocalPath('   '),
    'Path is required',
  );
  const inaccessiblePath = path.join(tempRoot, 'inaccessible');
  await fs.mkdir(inaccessiblePath, { mode: 0o700 });
  await fs.chmod(inaccessiblePath, 0o000);
  let inaccessibleMessage = '';
  try {
    inaccessibleMessage = await expectRejects(
      'inaccessible path',
      () => validateLocalPath(inaccessiblePath),
      'is not accessible',
    );
  } finally {
    await fs.chmod(inaccessiblePath, 0o700).catch(() => {});
  }

  const unsupported = unsupportedAppSpecificOpenError('projects', 'linux');
  assert(
    unsupported.includes('not supported on Linux') && unsupported.includes('default open action'),
    'unsupported app-specific Linux message should point to default open action',
  );

  console.log(JSON.stringify({
    ok: true,
    validated: validated.path,
    validatedDirectory: validatedDirectory.path,
    missingMessage,
    emptyMessage,
    inaccessibleMessage,
    unsupported,
  }, null, 2));
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
