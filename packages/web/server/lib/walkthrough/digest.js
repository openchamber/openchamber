import { isGeneratedArtifact } from './generated.js';
import { parseDiffFiles } from './hunks.js';

export function buildDigest(sections) {
  const files = [];
  for (const section of sections) {
    const parsed = parseDiffFiles(section.patch, section.scope);
    for (const file of parsed.files) {
      files.push({ ...file, scope: section.scope, generated: isGeneratedArtifact(file.path) });
    }
  }

  const idByAlias = new Map();
  const aliasById = new Map();
  let counter = 0;

  const digestFiles = files
    .filter((file) => !file.generated)
    .map((file) => ({
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
      ...(file.scope !== 'branch' && !file.scope.startsWith('pr:') ? { scope: file.scope } : {}),
      ...(file.binary ? { binary: true } : {}),
      hunks: file.hunks.map((hunk) => {
        counter += 1;
        const alias = `h${counter}`;
        idByAlias.set(alias, hunk.id);
        aliasById.set(hunk.id, alias);
        return {
          alias,
          header: hunk.header,
          oldLines: `${hunk.oldStart}-${hunk.oldStart + Math.max(0, hunk.oldLines - 1)}`,
          newLines: `${hunk.newStart}-${hunk.newStart + Math.max(0, hunk.newLines - 1)}`,
          added: hunk.added,
          deleted: hunk.deleted,
          patch: hunk.body,
        };
      }),
    }));

  const generatedFiles = files.filter((file) => file.generated);

  return {
    digest: { files: digestFiles },
    files,
    idByAlias,
    aliasById,
    hunkCount: counter,
    fileCount: digestFiles.length,
    generatedFileCount: generatedFiles.length,
    generatedPaths: generatedFiles.map((file) => file.path),
  };
}
