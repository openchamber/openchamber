import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { opencodeClient } from '@/lib/opencode/client';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { initializeRuntimeEndpoint } from '@/lib/runtime-switch';
import { generatePromptCandidates, loadPromptGenerationSession, selectPromptCandidates, type PromptCandidate } from './promptCandidates';
import { attachSessionToRun, detachSessionFromRun, saveFusionGuidance } from './membership';
import { buildMultiRunIndex } from './runs';
import { getMultiRunIdentity } from './identity';

const url = process.env.MULTIRUN_TEST_URL;
const root = process.env.MULTIRUN_TEST_ROOT;
// This opt-in uses a real OpenCode instance. The normal suite reports a skip,
// because pointing it at the user's running app would not be an isolated test.
const runtimeTest = url && root ? test : test.skip;

runtimeTest('real OpenCode generates candidates with selected aliases and effort, retaining partial successes', async () => {
  if (!url || !root) throw new Error('Isolated runtime parameters missing');
  const endpoint = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname)) throw new Error('Test server must be loopback');
  const fixtureRoot = realpathSync(root);
  const settingsResponse = await fetch(new URL('/api/config/settings', endpoint));
  if (!settingsResponse.ok) throw new Error('Could not verify the isolated server');
  const settings = z.object({ projects: z.array(z.object({ path: z.string() })) }).parse(await settingsResponse.json());
  if (!settings.projects.some((project) => resolve(project.path) === join(fixtureRoot, 'project'))) throw new Error('Server is not the isolated fixture');

  // Oracle: fixed candidate outputs plus independently observed OpenAI requests.
  // The HTTP server is synthetic and exposes no filesystem or tool operations.
  const outputs = new Map<string, Array<Omit<PromptCandidate, 'id' | 'model'>>>([
    ['wire-a', [
      { title: 'Parser tests', text: 'Review api_v2 with tests.', kind: 'variation' },
      { title: 'New accessibility task', text: 'Create a new accessibility audit.', kind: 'new' },
    ]],
    ['wire-b', [
      { title: 'Parser errors', text: 'Review api_v2 error handling.', kind: 'variation' },
      { title: 'New performance task', text: 'Create a new performance audit.', kind: 'new' },
    ]],
    ['wire-project', [
      { title: 'Project variation', text: 'Review api_v2 in this project.', kind: 'variation' },
      { title: 'Project new task', text: 'Create a new project audit.', kind: 'new' },
    ]],
  ]);
  const requestSchema = z.object({
    model: z.string(),
    messages: z.array(z.object({ content: z.union([
      z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() })).transform((parts) => parts.map((part) => part.text).join('\n')),
    ]) })),
    stream: z.boolean().optional(),
    tools: z.array(z.json()).optional(),
    fixture_effort: z.string().optional(),
  });
  const received: Array<z.infer<typeof requestSchema>> = [];
  const paths: string[] = [];
  const rejected: string[] = [];
  const provider = createServer(async (request, response) => {
    paths.push(request.url ?? '');
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    try {
      request.setEncoding('utf8');
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        // This fixture accepts only small synthetic prompts, not user data.
        if (raw.length > 1_048_576) throw new Error('Synthetic request too large');
      }
      const body = requestSchema.parse(JSON.parse(raw));
      received.push(body);
      const content = body.model === 'wire-invalid' ? 'Invalid candidate JSON' : JSON.stringify({ candidates: outputs.get(body.model) });
      const envelope = { id: 'chatcmpl-candidates', object: 'chat.completion', created: 1, model: body.model };
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...envelope, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
      }
    } catch (error) {
      rejected.push(String(error));
      response.writeHead(400).end('Invalid synthetic request');
    }
  });
  await new Promise<void>((ready, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', ready); });
  try {
    const address = z.object({ port: z.number().int().positive() }).parse(provider.address());
    const directory = mkdtempSync(join(fixtureRoot, 'candidate-generation-'));
    const marker = join(directory, 'retained-artifact.txt');
    writeFileSync(marker, 'Source artifact stays unchanged.\n');
    // Every fixture model is project-only. No global configuration changes.
    writeFileSync(join(directory, 'opencode.json'), JSON.stringify({
      providers: { 'prompt-fixture': {
        name: 'Prompt generation fixture', package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused' },
        models: {
          'candidate-a': { modelID: 'wire-a', variants: [{ id: 'careful', body: { fixture_effort: 'careful' } }] },
          'candidate-b': { modelID: 'wire-b' },
          'invalid-format': { modelID: 'wire-invalid' },
          'project-only': { modelID: 'wire-project' },
        },
      } },
    }));
    configureRuntimeUrlResolver({ apiBaseUrl: endpoint.origin });
    initializeRuntimeEndpoint({ apiBaseUrl: endpoint.origin });
    opencodeClient.reconnectToRuntimeBaseUrl();
    const catalog = await opencodeClient.getProvidersForConfig(directory, { fresh: true });
    expect(catalog.models.filter((model) => model.providerID === 'prompt-fixture').map((model) => model.id).sort()).toEqual(['candidate-a', 'candidate-b', 'invalid-format', 'project-only']);
    const models = [
      { providerID: 'prompt-fixture', id: 'candidate-a', variant: 'careful' },
      { providerID: 'prompt-fixture', id: 'candidate-b' },
      { providerID: 'prompt-fixture', id: 'invalid-format' },
      { providerID: 'prompt-fixture', id: 'project-only' },
    ];
    const result = await generatePromptCandidates({ original: 'Review api_v2', description: 'One variation and one new prompt from each model', models, directory });
    if (result.candidates.length === 0) throw new Error(JSON.stringify({ paths, rejected, failures: result.failures }));
    expect(result.candidates.map((candidate) => candidate.text)).toEqual([
      'Review api_v2 with tests.', 'Create a new accessibility audit.',
      'Review api_v2 error handling.', 'Create a new performance audit.',
      'Review api_v2 in this project.', 'Create a new project audit.',
    ]);
    expect(result.failures).toEqual([{ model: models[2], reason: 'generation' }]);
    expect(result.candidates.map((candidate) => candidate.model)).toEqual([models[0], models[0], models[1], models[1], models[3], models[3]]);
    expect(received.map((request) => request.model).sort()).toEqual(['wire-a', 'wire-b', 'wire-invalid', 'wire-project']);
    expect(received.find((request) => request.model === 'wire-a')?.fixture_effort).toBe('careful');
    if (received.some((request) => (request.tools?.length ?? 0) > 0)) throw new Error(`Generation exposed tools: ${JSON.stringify(received.map((request) => request.tools))}`);
    expect(received.every((request) => (request.tools?.length ?? 0) === 0)).toBe(true);
    for (const request of received) {
      expect(request.messages.map((message) => message.content).join('\n')).toContain('Review api_v2');
      expect(request.messages.map((message) => message.content).join('\n')).toContain('One variation and one new prompt from each model');
    }
    expect(selectPromptCandidates(result.candidates, new Set([result.candidates[0].id, result.candidates[3].id])).map((candidate) => candidate.text)).toEqual(['Review api_v2 with tests.', 'Create a new performance audit.']);
    expect(readFileSync(marker, 'utf8')).toBe('Source artifact stays unchanged.\n');
    expect(result.generationSessions).toHaveLength(4);
    for (const source of result.generationSessions) {
      const session = await opencodeClient.getSession(source.sessionID, source.directory);
      expect(session.time.archived).toBeTruthy();
      const saved = await loadPromptGenerationSession(source);
      if (saved.request === null) {
        const messages = await opencodeClient.getSessionMessages(source.sessionID, { order: 'asc', limit: 200 }, source.directory);
        throw new Error(`Missing generation request: ${JSON.stringify(messages.items.map(({ info }) => ({ role: info.role, metadata: info.metadata, text: info.role === 'synthetic' ? info.text.slice(0, 80) : undefined })))}`);
      }
      expect(saved.request).toContain('Review api_v2');
      expect(saved.result).toBeTruthy();
    }
    const legacyTitle = 'legacy-prompts/prompt-fixture/candidate-a';
    const anchor = await opencodeClient.createSession({ title: legacyTitle, model: models[0] }, directory);
    const sibling = await opencodeClient.createSession({ title: `${legacyTitle}/2`, model: models[0] }, directory);
    const run = [...buildMultiRunIndex([anchor, sibling], () => directory).runs.values()][0];
    if (!run) throw new Error('Legacy runtime fixture did not form a run');
    const existing = await opencodeClient.createSession({ title: 'Existing result', model: models[1] }, directory);
    const attached = await attachSessionToRun({ run, anchor, session: existing });
    expect(getMultiRunIdentity(attached)?.key).toBe(run.key);
    await saveFusionGuidance({ session: anchor, runKey: run.key, legacyDirectory: directory, guidance: 'Keep the source detail.' });
    const savedAnchor = await opencodeClient.getSession(anchor.id, directory);
    expect(getMultiRunIdentity(savedAnchor)?.guidance).toBe('Keep the source detail.');
    expect(getMultiRunIdentity(savedAnchor)?.key).toBe(run.key);
    expect(savedAnchor.title).toBe(legacyTitle);
    expect(await detachSessionFromRun({ session: attached, runKey: run.key, confirmed: false })).toBe(false);
    expect(getMultiRunIdentity(await opencodeClient.getSession(attached.id, directory))?.key).toBe(run.key);
    await detachSessionFromRun({ session: attached, runKey: run.key, confirmed: true });
    expect(getMultiRunIdentity(await opencodeClient.getSession(attached.id, directory))).toBeNull();
  } finally {
    await new Promise<void>((closed, reject) => provider.close((error) => error ? reject(error) : closed()));
  }
}, 120_000);
