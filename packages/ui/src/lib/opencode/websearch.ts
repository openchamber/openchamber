/**
 * OpenCode's web search, translated into the shapes chat and Settings read.
 *
 * Four OpenCode contracts meet here:
 * - `websearch.providers` (`GET /api/websearch/provider`): the providers the
 *   Location offers. Each one is also an integration of the same id that takes
 *   an optional API key (every built-in provider has a keyless tier).
 * - The `websearch` config key: `false` turns search off, `{ provider }` names
 *   a provider or `"random"`. Unset means OpenCode falls back to the answer
 *   the user gave its chat consent form (kept in its own store as
 *   `websearch:provider`, which no route reads or clears), and asks only when
 *   there is no answer yet.
 * - The `websearch` tool's text result: one `## [title](url)` block per hit,
 *   an optional `Published: <ISO>` line, then the snippet
 *   (`packages/core/src/tool/plugin/websearch.ts`).
 * - The consent form the tool raises on first use, tagged
 *   `metadata.kind === "websearch.provider"`.
 *
 * Every read throws on failure; a failed read is never an empty list.
 */

import type { IntegrationInfo } from "@opencode/client"
import { z } from "zod"
import { normalizeOpencodeError, opencodeClient, type OpenCodeClient } from "./client"
import type { Config, FormRequest, Metadata } from "./model"

export interface WebSearchProvider {
  id: string
  name: string
}

/** What the `websearch` config key says, as the user picks it in Settings. */
export type WebSearchSelection =
  /**
   * No config entry: OpenCode uses the answer given in chat, or asks on the
   * first search when there is none. Not "will ask": the stored answer wins.
   */
  | { kind: "default" }
  | { kind: "off" }
  /** Any available provider, moving on when one is rate limited. */
  | { kind: "random" }
  | { kind: "provider"; id: string }

/** How a provider's optional API key is supplied. */
export type WebSearchKeyStatus =
  /** The integration takes no key (a provider signed in elsewhere). */
  | { kind: "unsupported" }
  | { kind: "none" }
  /** A stored credential; `ids` are what removal needs. */
  | { kind: "stored"; ids: string[] }
  /** An environment variable the server can see. */
  | { kind: "env"; name: string }

export interface WebSearchProviderAccess {
  key: WebSearchKeyStatus
  /** Environment variables OpenCode reads a key from, for the hint. */
  envNames: string[]
}

const clientFor = (directory: string | null): OpenCodeClient =>
  directory ? opencodeClient.getScopedSdkClient(directory) : opencodeClient.getSdkClient()

async function call<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw normalizeOpencodeError(operation, error)
  }
}

/** Providers OpenCode offers for the directory's Location, sorted by name. */
export async function listWebSearchProviders(directory: string | null): Promise<WebSearchProvider[]> {
  const response = await call("websearch.providers", () => clientFor(directory).websearch.providers())
  return response.data.map((provider) => ({ id: provider.id, name: provider.name }))
}

export function readWebSearchSelection(config: Config): WebSearchSelection {
  const value = config.websearch
  if (value === undefined) return { kind: "default" }
  if (value === false) return { kind: "off" }
  if (value.provider === "random") return { kind: "random" }
  return { kind: "provider", id: value.provider }
}

/** The body `PUT /api/config/websearch` takes; `null` removes the entry. */
export function webSearchSelectionToConfig(selection: WebSearchSelection): false | string | null {
  switch (selection.kind) {
    case "default":
      return null
    case "off":
      return false
    case "random":
      return "random"
    case "provider":
      return selection.id
  }
}

const toAccess = (integration: IntegrationInfo | undefined): WebSearchProviderAccess => {
  const envNames = (integration?.methods ?? []).flatMap((method) => (method.type === "env" ? [...method.names] : []))
  const acceptsKey = (integration?.methods ?? []).some((method) => method.type === "key")
  if (!acceptsKey) return { key: { kind: "unsupported" }, envNames }
  const connections = integration?.connections ?? []
  const stored = connections.flatMap((connection) => (connection.type === "credential" ? [connection.id] : []))
  if (stored.length > 0) return { key: { kind: "stored", ids: stored }, envNames }
  const env = connections.find((connection) => connection.type === "env")
  if (env?.type === "env") return { key: { kind: "env", name: env.name }, envNames }
  return { key: { kind: "none" }, envNames }
}

/** How each provider's key is supplied, keyed by provider id. */
export async function readWebSearchAccess(
  directory: string | null,
  providerIds: readonly string[],
): Promise<Record<string, WebSearchProviderAccess>> {
  const response = await call("integration.list", () => clientFor(directory).integration.list())
  const access: Record<string, WebSearchProviderAccess> = {}
  for (const id of providerIds) {
    access[id] = toAccess(response.data.find((integration) => integration.id === id))
  }
  return access
}

export async function saveWebSearchKey(providerId: string, key: string): Promise<void> {
  await call("integration.connect.key", () =>
    opencodeClient.getSdkClient().integration.connect.key({ integrationID: providerId, key }),
  )
}

export async function removeWebSearchKey(credentialIds: readonly string[]): Promise<void> {
  const sdk = opencodeClient.getSdkClient()
  for (const credentialID of credentialIds) {
    await call("credential.remove", () => sdk.credential.remove({ credentialID }))
  }
}

// ---------------------------------------------------------------------------
// Tool result
// ---------------------------------------------------------------------------

export interface WebSearchResult {
  url: string
  host: string
  /** `null` when OpenCode had no title and repeated the URL instead. */
  title: string | null
  /** ISO timestamp. */
  published: string | null
  snippet: string | null
}

export type WebSearchOutput = { kind: "results"; results: WebSearchResult[] } | { kind: "empty" }

/** OpenCode's `NO_RESULTS` text. */
const NO_RESULTS_PREFIX = "No search results found."
const HEADING = /^## \[(.*)\]\((https?:\/\/\S+)\)$/
const PUBLISHED = /^Published: (\S+)$/

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return null
  }
}

/**
 * Reads the tool's text result. Returns `null` for anything that does not
 * follow OpenCode's format, so the caller can show the raw text instead.
 */
export function parseWebSearchOutput(content: string): WebSearchOutput | null {
  const text = content.trim()
  if (text.startsWith(NO_RESULTS_PREFIX)) return { kind: "empty" }
  const lines = text.split("\n")
  if (!HEADING.test(lines[0] ?? "")) return null

  const results: WebSearchResult[] = []
  let current: { url: string; host: string; title: string | null; published: string | null; body: string[] } | null = null
  const flush = () => {
    if (!current) return
    const snippet = current.body.join("\n").trim()
    results.push({
      url: current.url,
      host: current.host,
      title: current.title,
      published: current.published,
      snippet: snippet.length > 0 ? snippet : null,
    })
  }

  for (const line of lines) {
    const heading = HEADING.exec(line)
    if (heading) {
      const [, title = "", url = ""] = heading
      const host = hostOf(url)
      if (!host) return null
      flush()
      current = { url, host, title: title && title !== url ? title : null, published: null, body: [] }
      continue
    }
    if (!current) return null
    // The date line comes right after the heading, before the blank line.
    const published = current.body.length === 0 && current.published === null ? PUBLISHED.exec(line) : null
    if (published) {
      current.published = published[1] ?? null
      continue
    }
    current.body.push(line)
  }
  flush()
  return { kind: "results", results }
}

/** The provider id OpenCode records on a finished or failed search. */
const resultMetadataSchema = z.object({ provider: z.string().min(1) })

export function webSearchProviderOf(metadata: Metadata | undefined): string | null {
  return resultMetadataSchema.safeParse(metadata).data?.provider ?? null
}

// ---------------------------------------------------------------------------
// Consent form
// ---------------------------------------------------------------------------

export interface WebSearchConsentOption {
  value: string
  /** OpenCode's English label; the card localizes the values it knows. */
  label: string
}

/**
 * The first-use consent form. `choice` answers allow / choose / disable;
 * `provider` is the follow-up list when the user picked "choose".
 */
export type WebSearchConsent =
  | { step: "choice"; fieldKey: string; options: WebSearchConsentOption[] }
  | { step: "provider"; fieldKey: string; options: WebSearchConsentOption[] }

/** `null` for any other form, or one whose shape this card does not know. */
export function readWebSearchConsent(form: FormRequest): WebSearchConsent | null {
  if (form.metadata?.kind !== "websearch.provider") return null
  if (form.fields.length !== 1) return null
  const [field] = form.fields
  if (!field || field.type !== "string" || !field.options?.length) return null
  const options = field.options.map((option) => ({ value: option.value, label: option.label }))
  if (field.key === "choice") return { step: "choice", fieldKey: field.key, options }
  if (field.key === "provider") return { step: "provider", fieldKey: field.key, options }
  return null
}
