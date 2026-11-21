import { expect, spyOn, test } from "bun:test"
import { opencodeClient } from "@/lib/opencode/client"
import { readForkMessages } from "./session-metadata-helpers"

test("reads the fork transcript after a temporary OpenCode outage", async () => {
  const read = spyOn(opencodeClient, "getSessionMessages")
    .mockRejectedValueOnce(new Error("OpenCode API unavailable (503)"))
    .mockResolvedValueOnce({ items: [], cursor: {} })
  try {
    expect(await readForkMessages("ses_fork", "/repo", () => false)).toEqual([])
    expect(read).toHaveBeenCalledTimes(2)
  } finally {
    read.mockRestore()
  }
})

test("does not retry a fork transcript on a different runtime", async () => {
  let stale = false
  const read = spyOn(opencodeClient, "getSessionMessages").mockImplementation(async () => {
    stale = true
    throw new Error("OpenCode API unavailable (503)")
  })
  try {
    await expect(readForkMessages("ses_fork", "/repo", () => stale)).rejects.toThrow()
    expect(read).toHaveBeenCalledTimes(1)
  } finally {
    read.mockRestore()
  }
})
