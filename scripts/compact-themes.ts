import { readdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { compactTheme, requireTheme } from '../packages/ui/src/lib/theme/definition';

// Maintainer migration, also useful after importing a VS Code palette.
// Verify every candidate before writing any file; replace each file atomically.
const directory = path.resolve(import.meta.dirname, '../packages/ui/src/lib/theme/themes');
const files = (await readdir(directory)).filter((file) => file.endsWith('.json'));
const changes = await Promise.all(files.map(async (file) => {
  const filename = path.join(directory, file);
  const previous = JSON.parse(await readFile(filename, 'utf8'));
  const compact = compactTheme(previous);
  const before = JSON.parse(JSON.stringify(requireTheme(previous)).toLowerCase());
  const after = JSON.parse(JSON.stringify(requireTheme(compact)).toLowerCase());
  if (!isDeepStrictEqual(before, after)) {
    throw new Error(`Compaction changed resolved colors: ${file}`);
  }
  return { filename, contents: `${JSON.stringify(compact, null, 2)}\n` };
}));
for (const { filename, contents } of changes) {
  const temporary = `${filename}.tmp`;
  await writeFile(temporary, contents);
  await rename(temporary, filename);
}
console.log(`Compacted ${changes.length} themes; resolved colors are unchanged.`);
