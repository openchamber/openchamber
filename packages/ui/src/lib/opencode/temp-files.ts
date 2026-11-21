export type TempFileSource = { filename: string; bytes: Uint8Array | (() => Promise<Uint8Array>) }

export type TempFileResult = { filename: string; path: string } | { filename: string; error: Error }

export async function writeTempFiles(
  root: string,
  files: readonly TempFileSource[],
  assertCurrent: () => void,
  write: (path: string, payload: Uint8Array) => Promise<string>,
): Promise<TempFileResult[]> {
  const folderName = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("")
  const folder = `${root.replace(/[\\/]+$/, "")}/openchamber/${folderName}`
  const results: TempFileResult[] = []
  for (const { filename, bytes } of files) {
    let payload: Uint8Array
    try {
      payload = bytes instanceof Uint8Array ? bytes : await bytes()
    } catch (error) {
      results.push({ filename, error: error instanceof Error ? error : new Error(String(error)) })
      continue
    }
    assertCurrent()
    try {
      results.push({ filename, path: await write(`${folder}/${filename}`, payload) })
    } catch (error) {
      results.push({ filename, error: error instanceof Error ? error : new Error(String(error)) })
    }
  }
  return results
}
