import { isGeneratedArtifact } from './generated.js';
import { parseDiffFiles } from './hunks.js';

// The digest is what the model actually reads. Within what it covers there is
// no truncation: a diff that does not fit the model's context is refused
// upstream so the user can pick a roomier model, because a walkthrough written
// against a silently clipped diff is confidently wrong in a way nobody can see.
//
// The one thing it does not cover is tool-produced files (lockfiles, minified
// bundles, codegen). Those are excluded by name, not by size, and they are not
// hidden — they carry no hunk aliases, so nothing can anchor to them, and they
// surface in the uncovered tail like any other unreviewed change.

/**
 * Parse sections into files and build the model-facing digest.
 *
 * Hunks are exposed to the model as request-local aliases (`h1`, `h2`, …)
 * rather than their real ids: the aliases are far cheaper in tokens, and a
 * model cannot invent a plausible-looking id for a hunk that does not exist.
 */
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
    // Reviewable counts: what the model is actually asked about. The excluded
    // files still reach the client through `files`.
    hunkCount: counter,
    fileCount: digestFiles.length,
    generatedFileCount: generatedFiles.length,
    generatedPaths: generatedFiles.map((file) => file.path),
  };
}
