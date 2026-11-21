// packages/sdk/examples/source-control-provider/service/diff.ts
var FILE_STATUSES = new Map([["added", "added"], ["deleted", "removed"], ["removed", "removed"], ["renamed", "renamed"]]);
var mapChangedFile = (raw) => {
  const file = { path: raw.filename, status: FILE_STATUSES.get(raw.status ?? "") ?? "modified" };
  if (raw.additions !== undefined)
    file.additions = raw.additions;
  if (raw.deletions !== undefined)
    file.deletions = raw.deletions;
  if (raw.changes !== undefined)
    file.changes = raw.changes;
  return file;
};
var splitUnifiedDiff = (diff) => {
  const parts = new Map;
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  for (const chunk of chunks) {
    const lines = chunk.split(`
`);
    const plus = lines.find((line) => line.startsWith("+++ "));
    const minus = lines.find((line) => line.startsWith("--- "));
    const renamed = lines.find((line) => line.startsWith("rename to "));
    let path = "";
    if (plus && plus !== "+++ /dev/null")
      path = plus.slice(4).replace(/^b\//, "");
    else if (renamed)
      path = renamed.slice("rename to ".length);
    else if (minus && minus !== "--- /dev/null")
      path = minus.slice(4).replace(/^a\//, "");
    else
      path = lines[0].match(/^diff --git a\/.+? b\/(.+)$/)?.[1] ?? "";
    if (path)
      parts.set(path.replace(/\t.*$/, ""), chunk.endsWith(`
`) ? chunk : `${chunk}
`);
  }
  return parts;
};
export {
  mapChangedFile,
  splitUnifiedDiff
};
