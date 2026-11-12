/**
 * Client-generated ids in OpenCode's own format (`@opencode/schema`'s
 * `Identifier`). Kept apart from the client module so callers that need only
 * an id (optimistic messages, a session created from a draft) do not pull in
 * the transport, and tests that mock the client keep this helper real.
 */

const ID_RANDOM_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
const ID_RANDOM_LENGTH = 14

let lastIdTimestamp = 0
let idCounter = 0

const randomBase62 = (length: number): string => {
  const bytes = new Uint8Array(length)
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(bytes)
  } else {
    for (let index = 0; index < length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }

  let result = ""
  for (let index = 0; index < length; index += 1) {
    result += ID_RANDOM_CHARS[bytes[index] % ID_RANDOM_CHARS.length]
  }
  return result
}

/**
 * OpenCode's id: a 6-byte time prefix in hex, then random characters. The
 * prefix counts up with time for ascending ids and down (its bitwise
 * complement) for descending ones, so lexical order is time order either way.
 */
const timeSortableId = (prefix: string, descending: boolean): string => {
  const timestamp = Date.now()
  if (timestamp !== lastIdTimestamp) {
    lastIdTimestamp = timestamp
    idCounter = 0
  }
  idCounter += 1

  const current = BigInt(timestamp) * BigInt(0x1000) + BigInt(idCounter)
  const sortable = descending ? ~current : current
  const timeBytes = new Uint8Array(6)
  for (let index = 0; index < 6; index += 1) {
    timeBytes[index] = Number((sortable >> BigInt(40 - 8 * index)) & BigInt(0xff))
  }
  const hex = Array.from(timeBytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${prefix}_${hex}${randomBase62(ID_RANDOM_LENGTH)}`
}

/** A message id as OpenCode mints them: newer sorts after older, so client-minted ids sort with the server's. */
export const ascendingId = (prefix: "msg"): string => timeSortableId(prefix, false)

/** A session id as OpenCode mints them: newer sorts before older, so a client-minted session lists with the server's. */
export const descendingId = (prefix: "ses"): string => timeSortableId(prefix, true)
