#!/usr/bin/env node
/**
 * A deterministic model provider for streaming captures.
 *
 * A real model is a poor stimulus for a comparison: the same prompt returns a
 * different length at a different speed every time, and what a streamed
 * response costs depends on both. This server speaks the OpenAI-compatible
 * chat-completions protocol and always streams the same markdown document, at
 * the rate the requested model name asks for, so two captures differ only in
 * the application under test.
 *
 * OpenCode still does all of its real work. It receives provider chunks, turns
 * them into parts and deltas, and emits its usual event stream, so OpenChamber
 * sees exactly what it would see from a hosted model that happened to be this
 * fast.
 *
 * Model names select the speed: `stream-300cps` streams 300 characters per
 * second. Hosted models sit between roughly 100 and 1500. `code-300cps`
 * streams a different document at the same kind of rate: a short introduction
 * and one 240-line TypeScript block, because what a growing code fence costs
 * (highlighting, lexing) does not show in fences of five lines. `think-30s` stays
 * silent for thirty seconds and then answers in one word, which holds the app
 * in its "working" state with nothing streaming: the cost of the busy
 * indicator and of whatever else runs while an agent thinks or uses a tool.
 * `agent-20tools-300cps` behaves like an agent: twenty steps that each say a
 * line and call the `glob` tool, then the document. OpenCode runs the tools
 * for real, so the turn on screen carries twenty tool parts by the time the
 * answer streams, which is the shape a long agentic turn has and what the
 * cost of re-rendering a whole turn per delta depends on.
 */

import { createServer } from "node:http"
import process from "node:process"

const FIXTURE_PROVIDER_ID = "perf"
const FIXTURE_RATES = [100, 300, 600, 1200]
const FIXTURE_CODE_RATES = [300, 1200]
const FIXTURE_THINK_SECONDS = [30]
const FIXTURE_AGENT_STEPS = [20, 40]
const FIXTURE_AGENT_RATES = [300]
const THINK_ANSWER = "Done."
const CHUNK_CHARACTERS = 4

// Read-only lookups over the session's directory: small results, no
// permission prompt, and a different one on each step.
const AGENT_GLOBS = ["packages/*/package.json", "scripts/perf/*.mjs", "*.md", ".agents/skills/*/SKILL.md"]
const AGENT_STEP_TEXT = (step, total) => `Step ${step} of ${total}: listing files that the answer should mention.\n\n`

const SECTION = (index) => `## ${index}. Executing a call in a bytecode virtual machine

A bytecode virtual machine executes a function call by creating a new **activation record**, binding the
arguments, and transferring control to the callee's first instruction. The caller's state is preserved so that
execution resumes at the instruction after the call once the callee returns. Round ${index} of this document
repeats the explanation so that the response is long enough to measure.

1. The compiler emits a \`CALL\` instruction carrying the argument count.
2. The interpreter pops the callee and its arguments from the operand stack.
3. A frame is pushed holding the return address, the base pointer and the locals.
4. The dispatch loop continues at the callee's entry point.

\`\`\`python
def call(vm, argc):
    callee = vm.stack[-argc - 1]
    frame = Frame(callee, base=len(vm.stack) - argc, return_ip=vm.ip)
    vm.frames.append(frame)
    vm.ip = callee.entry
\`\`\`

\`\`\`rust
fn call(&mut self, argc: usize) -> Result<(), VmError> {
    let base = self.stack.len() - argc;
    let callee = self.stack[base - 1].as_function()?;
    self.frames.push(Frame { base, return_ip: self.ip, function: callee.clone() });
    self.ip = callee.entry;
    Ok(())
}
\`\`\`

\`\`\`typescript
function call(vm: Vm, argc: number): void {
  const base = vm.stack.length - argc
  const callee = asFunction(vm.stack[base - 1])
  vm.frames.push({ base, returnIp: vm.ip, fn: callee })
  vm.ip = callee.entry
}
\`\`\`

| Aspect | Stack machine | Register machine |
|---|---|---|
| Operands | implicit, on the operand stack | explicit register indices |
| Instruction size | small | larger |
| Instruction count | higher | lower |
| Call setup | arguments already in place | arguments copied into a window |

Returning reverses the sequence: the result is moved to where the caller expects it, the frame is popped, and
the instruction pointer is restored from the saved return address.

`

const FIXTURE_DOCUMENT = [1, 2, 3].map(SECTION).join("")

const FENCE = "```"

// Plain string concatenation in the sample: nested template literals would
// need escaping here and add nothing to what is measured.
const CODE_FUNCTION = (index) => [
  `/** Resolves the owner of entry ${index} and caches the answer. */`,
  `export function resolveOwner${index}(entries: Map<string, Entry>, key: string): Owner | undefined {`,
  `  const cacheKey = key + ":${index}"`,
  "  const cached = ownerCache.get(cacheKey)",
  "  if (cached) return cached",
  "  const entry = entries.get(key)",
  `  if (!entry || entry.revision < ${index}) return undefined`,
  `  const owner = { id: entry.ownerId, label: "owner-" + entry.ownerId, depth: ${index % 7} }`,
  "  ownerCache.set(cacheKey, owner)",
  "  return owner",
  "}",
  "",
].join("\n")

const FIXTURE_CODE_DOCUMENT = [
  "## Ownership index",
  "",
  "The index below resolves an owner once per key and revision, then serves every later read from the cache.",
  "",
  `${FENCE}typescript`,
  "type Entry = { ownerId: string; revision: number }",
  "type Owner = { id: string; label: string; depth: number }",
  "",
  "const ownerCache = new Map<string, Owner>()",
  "",
  Array.from({ length: 22 }, (_, index) => CODE_FUNCTION(index + 1)).join("\n") + FENCE,
  "",
  "Each function is independent, so the cache can be cleared per revision without touching the others.",
  "",
].join("\n")

const parseModel = (model) => {
  const think = /think-(\d+)s/.exec(String(model ?? ""))
  if (think) return { delayMs: Number(think[1]) * 1000, charactersPerSecond: 1200, document: THINK_ANSWER, toolSteps: 0 }
  const agent = /agent-(\d+)tools-(\d+)cps/.exec(String(model ?? ""))
  if (agent) return { delayMs: 0, charactersPerSecond: Math.max(1, Number(agent[2])), document: FIXTURE_DOCUMENT, toolSteps: Number(agent[1]) }
  const rate = /(stream|code)-(\d+)cps/.exec(String(model ?? ""))
  return {
    delayMs: 0,
    charactersPerSecond: rate ? Math.max(1, Number(rate[2])) : 300,
    document: rate?.[1] === "code" ? FIXTURE_CODE_DOCUMENT : FIXTURE_DOCUMENT,
    toolSteps: 0,
  }
}

/**
 * What this request should answer. An agent model counts the tool results
 * already in the conversation: while steps remain it says a line and calls a
 * tool, and once every step has run it streams the document.
 */
const planResponse = (model, body) => {
  const { delayMs, charactersPerSecond, document, toolSteps } = parseModel(model)
  const toolResults = (Array.isArray(body.messages) ? body.messages : []).filter((message) => message?.role === "tool").length
  if (toolSteps > 0 && toolResults < toolSteps) {
    const step = toolResults + 1
    return {
      delayMs,
      charactersPerSecond,
      text: AGENT_STEP_TEXT(step, toolSteps),
      toolCall: { id: `call_fixture_${step}`, name: "glob", arguments: { pattern: AGENT_GLOBS[toolResults % AGENT_GLOBS.length] } },
    }
  }
  return { delayMs, charactersPerSecond, text: document, toolCall: null }
}

const chunkFrame = (model, delta, finishReason = null) => ({
  id: "chatcmpl-fixture",
  object: "chat.completion.chunk",
  created: 0,
  model,
  choices: [{ index: 0, delta, finish_reason: finishReason }],
})

const sseFrame = (payload) => `data: ${JSON.stringify(payload)}\n\n`

const readBody = (request) => new Promise((resolveBody) => {
  let body = ""
  request.on("data", (chunk) => { body += chunk })
  request.on("end", () => {
    try {
      resolveBody(JSON.parse(body || "{}"))
    } catch {
      resolveBody({})
    }
  })
})

const usageFor = (text) => ({ prompt_tokens: 1, completion_tokens: Math.ceil(text.length / 4), total_tokens: 1 + Math.ceil(text.length / 4) })

/**
 * Streams text against a wall-clock schedule rather than a fixed interval, so
 * timer drift cannot change the delivered rate between runs. Resolves once the
 * whole text is out, or rejects when the client went away first.
 */
const streamText = (response, model, text, { delayMs, charactersPerSecond }) => new Promise((resolveStream, reject) => {
  const startedAt = Date.now() + delayMs
  let sent = 0
  const timer = setInterval(() => {
    const elapsedSeconds = Math.max(0, Date.now() - startedAt) / 1000
    const due = Math.min(text.length, Math.floor(elapsedSeconds * charactersPerSecond))
    while (sent < due) {
      const next = Math.min(due, sent + CHUNK_CHARACTERS)
      response.write(sseFrame(chunkFrame(model, { content: text.slice(sent, next) })))
      sent = next
    }
    if (sent < text.length) return
    clearInterval(timer)
    resolveStream()
  }, 5)
  response.on("close", () => {
    clearInterval(timer)
    reject(new Error("client closed the stream"))
  })
})

const streamCompletion = async (response, model, body) => {
  const plan = planResponse(model, body)
  response.write(sseFrame(chunkFrame(model, { role: "assistant", content: "" })))
  try {
    await streamText(response, model, plan.text, plan)
  } catch {
    return
  }
  if (plan.toolCall) {
    // The shape the OpenAI protocol streams a call in: the name with the first
    // frame, the arguments as they are produced, and a matching finish reason.
    const { id, name, arguments: args } = plan.toolCall
    response.write(sseFrame(chunkFrame(model, { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: "" } }] })))
    response.write(sseFrame(chunkFrame(model, { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] })))
    response.write(sseFrame({ ...chunkFrame(model, {}, "tool_calls"), usage: usageFor(plan.text) }))
  } else {
    response.write(sseFrame({ ...chunkFrame(model, {}, "stop"), usage: usageFor(plan.text) }))
  }
  response.end("data: [DONE]\n\n")
}

const startFixtureProvider = (port) => new Promise((resolveServer, reject) => {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) {
      response.writeHead(404).end()
      return
    }
    const body = await readBody(request)
    // Title generation and other auxiliary calls are not part of the stimulus.
    if (!body.stream) {
      response.writeHead(200, { "content-type": "application/json" })
      response.end(JSON.stringify({
        id: "chatcmpl-fixture",
        object: "chat.completion",
        created: 0,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: "Streaming capture" }, finish_reason: "stop" }],
        usage: usageFor("Streaming capture"),
      }))
      return
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" })
    void streamCompletion(response, body.model, body)
  })
  server.on("error", reject)
  server.listen(port, "127.0.0.1", () => resolveServer(server))
})

/** OpenCode configuration that registers this provider; pass it as `OPENCODE_CONFIG_CONTENT`. */
const fixtureProviderConfig = (port) => ({
  provider: {
    [FIXTURE_PROVIDER_ID]: {
      npm: "@ai-sdk/openai-compatible",
      name: "Performance fixture",
      options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "unused" },
      models: Object.fromEntries([
        ...FIXTURE_RATES.map((rate) => [`stream-${rate}cps`, { name: `Fixture stream, ${rate} characters/s` }]),
        ...FIXTURE_CODE_RATES.map((rate) => [`code-${rate}cps`, { name: `Fixture code block, ${rate} characters/s` }]),
        ...FIXTURE_THINK_SECONDS.map((seconds) => [`think-${seconds}s`, { name: `Fixture silence, ${seconds}s` }]),
        ...FIXTURE_AGENT_STEPS.flatMap((steps) => FIXTURE_AGENT_RATES.map((rate) => [
          `agent-${steps}tools-${rate}cps`,
          { name: `Fixture agent, ${steps} tool calls then ${rate} characters/s`, tool_call: true },
        ])),
      ]),
    },
  },
})

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 4601)
  if (process.argv.includes("--print-config")) {
    console.log(JSON.stringify(fixtureProviderConfig(port)))
  } else {
    await startFixtureProvider(port)
    console.log(`Fixture provider listening on http://127.0.0.1:${port}/v1 (${FIXTURE_DOCUMENT.length} characters per response)`)
    console.log(`Models: ${Object.keys(fixtureProviderConfig(port).provider[FIXTURE_PROVIDER_ID].models).map((id) => `${FIXTURE_PROVIDER_ID}/${id}`).join(", ")}`)
  }
}
