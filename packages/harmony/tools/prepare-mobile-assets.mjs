import { cp, mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const harmonyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const defaultSource = path.resolve(harmonyRoot, '../mobile/dist');
export const defaultDestination = path.resolve(
  harmonyRoot,
  'entry/src/main/resources/rawfile/mobile',
);

const assertDirectory = async (directory, label) => {
  const info = await stat(directory).catch(() => null);
  if (!info?.isDirectory()) {
    throw new Error(`${label} does not exist: ${directory}`);
  }
};

export const prepareMobileAssets = async ({
  source = defaultSource,
  destination = defaultDestination,
} = {}) => {
  const resolvedSource = path.resolve(source);
  const resolvedDestination = path.resolve(destination);
  const entryHtml = path.join(resolvedSource, 'index.html');

  await assertDirectory(resolvedSource, 'Mobile build output');
  const entryInfo = await stat(entryHtml).catch(() => null);
  if (!entryInfo?.isFile()) {
    throw new Error(`Mobile build entry is missing: ${entryHtml}`);
  }
  if (resolvedDestination === resolvedSource || resolvedDestination.startsWith(`${resolvedSource}${path.sep}`)) {
    throw new Error('Harmony asset destination must not be inside the mobile build output.');
  }

  const parent = path.dirname(resolvedDestination);
  const temporary = path.join(parent, `.mobile-assets-${process.pid}`);
  const backup = path.join(parent, `.mobile-assets-backup-${process.pid}`);
  await mkdir(parent, { recursive: true });
  await rm(temporary, { recursive: true, force: true });
  await rm(backup, { recursive: true, force: true });

  try {
    await cp(resolvedSource, temporary, { recursive: true });
    const existing = await stat(resolvedDestination).catch(() => null);
    if (existing) {
      await rename(resolvedDestination, backup);
    }
    try {
      await rename(temporary, resolvedDestination);
    } catch (error) {
      if (existing) {
        await rename(backup, resolvedDestination);
      }
      throw error;
    }
    await rm(backup, { recursive: true, force: true }).catch(() => undefined);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }

  const files = await readdir(resolvedDestination, { recursive: true, withFileTypes: true });
  return {
    destination: resolvedDestination,
    fileCount: files.filter((entry) => entry.isFile()).length,
  };
};

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const result = await prepareMobileAssets();
  console.log(`Prepared ${result.fileCount} MobileApp assets in ${result.destination}`);
}
