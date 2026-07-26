import { describe, expect, test } from "bun:test"
import type { FilesAPI } from "@/lib/api/types"
import { createContentCachedFiles } from "./content-cache-owner"

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

describe("content cache owner", () => {
  test("reuses only strongly validated content", async () => {
    let reads = 0
    const files = {
      readFile: async (path: string) => ({ path, content: `value-${++reads}` }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 7, mtimeMs: 1 }),
    } as unknown as FilesAPI
    const owner = createContentCachedFiles(files)

    expect((await owner.files.readFile!("file.ts")).content).toBe("value-1")
    expect((await owner.files.readFile!("file.ts")).content).toBe("value-1")
    expect(reads).toBe(1)
    owner.dispose()
  })

  test("does not retain size-only reads without mtime", async () => {
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string) => ({ path, content: `value-${++reads}` }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 7 }),
    } as unknown as FilesAPI)

    await owner.files.readFile!("file.ts")
    await owner.files.readFile!("file.ts")
    expect(reads).toBe(2)
    owner.dispose()
  })

  test("retries a read that overlaps a write", async () => {
    const firstRead = deferred<{ path: string; content: string }>()
    let content = "old"
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string) => {
        reads += 1
        return reads === 1 ? firstRead.promise : { path, content }
      },
      statFile: async () => ({ isFile: true, isDirectory: false, size: content.length, mtimeMs: content === "old" ? 1 : 2 }),
      writeFile: async (_path: string, next: string) => { content = next },
    } as unknown as FilesAPI)

    const reading = owner.files.readFile!("file.ts")
    await owner.files.writeFile!("file.ts", "new")
    firstRead.resolve({ path: "file.ts", content: "old" })

    expect((await reading).content).toBe("new")
    expect(reads).toBe(2)
    owner.dispose()
  })

  test("separates identical paths by directory scope", async () => {
    let reads = 0
    const owner = createContentCachedFiles({
      readFile: async (path: string, options?: Parameters<NonNullable<FilesAPI['readFile']>>[1]) => ({ path, content: `${options?.directory}-${++reads}` }),
      statFile: async () => ({ isFile: true, isDirectory: false, size: 1, mtimeMs: 1 }),
    } as unknown as FilesAPI)

    const first = await owner.files.readFile!("file.ts", { directory: "/a" })
    const second = await owner.files.readFile!("file.ts", { directory: "/b" })
    expect(first.content).toBe("/a-1")
    expect(second.content).toBe("/b-2")
    owner.dispose()
  })
})
