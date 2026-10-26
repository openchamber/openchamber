import { expect, test } from "bun:test"
import { olderMessagesCursor } from "./messageCursor"

test("encodes the next cursor OpenCode returns for a page ending at the message", () => {
  const cursor = olderMessagesCursor("msg_e9a1c0ffee01ABCdef")

  expect(/[+/=]/.test(cursor)).toBe(false)
  // How OpenCode's message handler decodes it.
  expect(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")))
    .toEqual({ id: "msg_e9a1c0ffee01ABCdef", order: "desc", direction: "next" })
})
