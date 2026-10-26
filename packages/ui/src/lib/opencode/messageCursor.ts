/**
 * The cursor that continues a newest-first message page below `messageID`:
 * OpenCode's `next` cursor for a page whose oldest record it is, base64url JSON
 * of that record's id, the order and the direction
 * (`packages/server/src/handlers/message.ts` in OpenCode). A transcript that
 * dropped its oldest records resumes older history from the oldest one it
 * kept. Message ids are ASCII, so `btoa` encodes them as UTF-8 would.
 */
export const olderMessagesCursor = (messageID: string): string =>
  btoa(JSON.stringify({ id: messageID, order: "desc", direction: "next" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
