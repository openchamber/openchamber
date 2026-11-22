import { isGeneratedArtifact } from './generated.js';
import { parseDiffFiles } from './hunks.js';
import type { DiffFile } from './hunks.js';

export interface DiffSection {
  scope: string;
  patch: string;
}

export interface DigestFile extends DiffFile {
  scope: string;
  generated: boolean;
}

interface DigestPaths {
  path: string;
  oldPath?: string;
}

interface DigestFlags {
  scope?: string;
  binary?: true;
}

export function buildDigest(sections: DiffSection[]) {
  const files: DigestFile[] = [];
  for (const section of sections) {
    const parsed = parseDiffFiles(section.patch, section.scope);
    for (const file of parsed.files) {
      files.push({ ...file, scope: section.scope, generated: isGeneratedArtifact(file.path) });
    }
  }

  const idByAlias = new Map<string, string>();
  const aliasById = new Map<string, string>();
  let counter = 0;

  const digestFiles = files
    .filter((file) => !file.generated)
    .map((file) => {
      const paths: DigestPaths = { path: file.path };
      if (file.oldPath) paths.oldPath = file.oldPath;
      const flags: DigestFlags = {};
      if (file.scope !== 'branch' && !file.scope.startsWith('pr:')) flags.scope = file.scope;
      if (file.binary) flags.binary = true;
      return {
        ...paths,
        status: file.status,
        ...flags,
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
      };
    });

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
