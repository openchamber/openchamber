const TEST_FILE = /(\.(test|spec|vitest|fixture|test-support|bench)\.[cm]?[jt]sx?$|\/(__tests__|tests?)\/)/;

export function toPosix(filename: string): string {
  return filename.replaceAll("\\", "/");
}

export function isTestFile(filename: string): boolean {
  return TEST_FILE.test(toPosix(filename));
}

export function isUiSource(filename: string): boolean {
  return toPosix(filename).includes("/packages/ui/src/") && !isTestFile(filename);
}

export function isPackageSource(filename: string): boolean {
  return /\/packages\/[^/]+\//.test(toPosix(filename)) && !isTestFile(filename);
}

export function isUnder(filename: string, folders: readonly string[]): boolean {
  const posix = toPosix(filename);
  return folders.some((folder) => posix.includes(folder));
}
