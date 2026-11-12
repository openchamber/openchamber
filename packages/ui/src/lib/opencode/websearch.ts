/**
 * OpenCode's web search, translated into the shapes chat and Settings read.
 *
 * Four OpenCode contracts meet here:
 * - `websearch.providers` (`GET /api/websearch/provider`): the providers the
 *   Location offers. Each one is also an integration of the same id that takes
 *   an optional API key (every built-in provider has a keyless tier). A
 *   plugin provider may join the list only once connected; its integration
 *   carries `metadata.websearch` so the page can offer it before that.
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

/** One text field a provider asks for when it connects, such as a server URL. */
export interface WebSearchConnectField {
  key: string
  /** The provider's own label; plugins write it in English. */
  label: string
  /** The provider's own explanation of the field, in its language. */
  description: string | null
  /** An example value. */
  placeholder: string | null
  required: boolean
  url: boolean
}

/** How the page connects a provider. */
export type WebSearchConnectMethod =
  /** An API key, plus any fields the key method's form asks for. */
  | { kind: "key"; fields: WebSearchConnectField[] }
  /** Only form fields, saved as a reference (a server the user runs). */
  | { kind: "form"; methodID: string; fields: WebSearchConnectField[] }

export interface WebSearchProviderAccess {
  key: WebSearchKeyStatus
  /** Environment variables OpenCode reads a key from, for the hint. */
  envNames: string[]
  /** `null` exactly when `key` is `unsupported`. */
  connect: WebSearchConnectMethod | null
}

/** The values a connect method's form fields were given, by field key. */
export type WebSearchConnectAnswer = Record<string, string>

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

type IntegrationMethod = IntegrationInfo["methods"][number]
type FormField = NonNullable<Extract<IntegrationMethod, { type: "key" }>["form"]>[number]

/**
 * A plugin marks an integration that is the account of a web search provider
 * with `metadata.websearch === true`. Such a provider joins OpenCode's
 * `websearch` list only once it is connected, so the marker is how the page
 * offers it before that, and how model provider lists leave it out.
 */
export function isWebSearchIntegration(integration: IntegrationInfo): boolean {
  return integration.metadata?.websearch === true
}

/**
 * The page renders plain text fields only. A form with any other field (a
 * choice, a number, a conditional field) is left to OpenCode's own `/connect`.
 */
function toConnectFields(form: readonly FormField[] | undefined): WebSearchConnectField[] | null {
  const fields: WebSearchConnectField[] = []
  for (const field of form ?? []) {
    if (field.type !== "string" || field.options?.length || field.when?.length) return null
    if (field.hidden) continue
    fields.push({
      key: field.key,
      label: field.title ?? field.key,
      description: field.description ?? null,
      placeholder: field.placeholder ?? null,
      required: field.required === true,
      url: field.format === "uri",
    })
  }
  return fields
}

function toConnectMethod(methods: readonly IntegrationMethod[]): WebSearchConnectMethod | null {
  for (const method of methods) {
    if (method.type !== "key") continue
    const fields = toConnectFields(method.form)
    if (fields) return { kind: "key", fields }
  }
  for (const method of methods) {
    if (method.type !== "external" || !method.form) continue
    const fields = toConnectFields(method.form)
    if (fields && fields.length > 0) return { kind: "form", methodID: method.id, fields }
  }
  return null
}

const toAccess = (integration: IntegrationInfo | undefined): WebSearchProviderAccess => {
  const methods = integration?.methods ?? []
  const envNames = methods.flatMap((method) => (method.type === "env" ? [...method.names] : []))
  const connect = toConnectMethod(methods)
  if (!connect) return { key: { kind: "unsupported" }, envNames, connect: null }
  const connections = integration?.connections ?? []
  const stored = connections.flatMap((connection) => (connection.type === "credential" ? [connection.id] : []))
  if (stored.length > 0) return { key: { kind: "stored", ids: stored }, envNames, connect }
  const env = connections.find((connection) => connection.type === "env")
  if (env?.type === "env") return { key: { kind: "env", name: env.name }, envNames, connect }
  return { key: { kind: "none" }, envNames, connect }
}

export interface WebSearchAccounts {
  /** How each provider's key is supplied, keyed by provider id. */
  access: Record<string, WebSearchProviderAccess>
  /**
   * Marked providers OpenCode does not list for search yet, because they are
   * not connected. Sorted by name; `access` covers them too.
   */
  connectable: WebSearchProvider[]
}

/** The accounts behind the listed providers, and the marked providers not listed yet. */
export function projectWebSearchAccounts(
  integrations: readonly IntegrationInfo[],
  providerIds: readonly string[],
): WebSearchAccounts {
  const listed = new Set(providerIds)
  const connectable = integrations
    .filter((integration) => isWebSearchIntegration(integration) && !listed.has(integration.id))
    .map((integration) => ({ id: integration.id, name: integration.name || integration.id }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
  const access: Record<string, WebSearchProviderAccess> = {}
  for (const id of [...providerIds, ...connectable.map((provider) => provider.id)]) {
    access[id] = toAccess(integrations.find((integration) => integration.id === id))
  }
  return { access, connectable }
}

export async function readWebSearchAccounts(
  directory: string | null,
  providerIds: readonly string[],
): Promise<WebSearchAccounts> {
  const response = await call("integration.list", () => clientFor(directory).integration.list())
  return projectWebSearchAccounts(response.data, providerIds)
}

/**
 * Connects a provider. Scoped to the current directory like the reads: a
 * plugin's provider exists in the locations that loaded the plugin, which the
 * home location may not have done yet.
 */
export async function saveWebSearchCredential(
  directory: string | null,
  providerId: string,
  connect: WebSearchConnectMethod,
  input: { key: string; answer: WebSearchConnectAnswer },
): Promise<void> {
  const answer = Object.keys(input.answer).length > 0 ? input.answer : undefined
  const integration = clientFor(directory).integration
  if (connect.kind === "key") {
    await call("integration.connect.key", () => integration.connect.key({ integrationID: providerId, key: input.key, answer }))
    return
  }
  await call("integration.connect.external", () =>
    integration.connect.external({ integrationID: providerId, methodID: connect.methodID, answer }),
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
