export interface WorkspaceFolderInput {
  name: string;
  uri: { fsPath: string };
}

export interface WorkspaceFolderCandidate {
  name: string;
  path: string;
}

export function resolveWorkspaceFolders(
  folders: ReadonlyArray<WorkspaceFolderInput>
): WorkspaceFolderCandidate[] {
  const seen = new Map<string, WorkspaceFolderCandidate>();
  for (const folder of folders) {
    const path = folder.uri.fsPath.replace(/[\\/]+$/, '');
    if (!seen.has(path)) {
      seen.set(path, { name: folder.name, path });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );
}
