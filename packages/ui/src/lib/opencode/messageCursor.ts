export const olderMessagesCursor = (messageID: string): string =>
  btoa(JSON.stringify({ id: messageID, order: "desc", direction: "next" }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
