// external: https://github.com/anomalyco/opencode/blob/v2.4.1/packages/core/src/session/background-result.ts Since 2.4.0 every background report is one <background-result kind="..."> block; history from 2.3 keeps <subagent> and <shell> blocks.
const ENVELOPE = /^\s*<(background-result|subagent|shell)\b([^>]*)>\r?\n?([\s\S]*?)\r?\n?<\/\1>\s*$/i
const KIND = /\bkind="([^"]*)"/

export type BackgroundResultKind = "subagent" | "shell"

export function unwrapBackgroundResult(text: string, kind: BackgroundResultKind): string | undefined {
  const match = text.match(ENVELOPE)
  if (!match) return undefined
  const [, tag, attributes, body] = match
  const name = tag.toLowerCase()
  const reported = name === "background-result" ? attributes.match(KIND)?.[1] : name
  return reported === kind ? body : undefined
}
